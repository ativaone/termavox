import { ErrorCode, TermdockError } from '@termdock/shared';
import {
  DEFAULT_READY_TIMEOUT_MS,
  type HostKeyDecision,
  type HostKeyInfo,
  INTERACTIVE_READY_TIMEOUT_MS,
  type KeyboardInteractiveRequest,
  SshTransport,
} from '../transport/ssh/index.ts';
import type {
  CredentialProvider,
  HostKeyStore,
  PresentedHostKey,
  SessionRecord,
  Transport,
} from './types.ts';

/** Callbacks from the transport handshake into the session runtime. */
export interface TransportHooks {
  /** The server presented its host key and the trust store decided (plan §5.9). */
  onHostKey(key: HostKeyInfo, decision: HostKeyDecision): void;
  /** Relays a keyboard-interactive round; resolves null when the prompt expired (§5.10). */
  onKeyboardInteractive(request: KeyboardInteractiveRequest): Promise<string[] | null>;
}

/** Builds a fresh, single-use transport for one connect attempt. */
export interface TransportFactory {
  create(record: SessionRecord, hooks: TransportHooks): Promise<Transport>;
}

/**
 * Host-key policy against the trusted keys of a host: a trusted key of the same type and
 * fingerprint → trusted; no trusted key at all → unknown (prompt); trusted keys exist but none
 * matches (same type with another fingerprint, or only other key types) → mismatch. The last
 * case is deliberately strict: offering a different key type is a classic downgrade attempt.
 */
export function decideHostKey(
  trusted: ReadonlyMap<string, PresentedHostKey>,
  key: HostKeyInfo,
): HostKeyDecision {
  if (trusted.size === 0) return 'unknown';
  return trusted.get(key.type)?.fingerprint === key.fingerprint ? 'trusted' : 'mismatch';
}

export interface SshTransportFactoryOptions {
  hostKeys: HostKeyStore;
  credentials: CredentialProvider;
  /** Overrides the handshake timeout (tests); otherwise chosen per credential kind. */
  readyTimeoutMs?: number;
}

/** Default factory: `SshTransport` for `kind: ssh` targets (local mode arrives in Phase 6). */
export class SshTransportFactory implements TransportFactory {
  readonly #options: SshTransportFactoryOptions;

  constructor(options: SshTransportFactoryOptions) {
    this.#options = options;
  }

  async create(record: SessionRecord, hooks: TransportHooks): Promise<Transport> {
    const { target, policies } = record;
    if (target.kind !== 'ssh') {
      throw new TermdockError(ErrorCode.LocalShellDisabled, 'local sessions are not available');
    }
    if (!target.hostId) {
      throw new TermdockError(ErrorCode.HostKeyRejected, 'the host of this session was deleted');
    }
    // Loaded before connect, so the verifier answers synchronously during the handshake.
    const { hostKeys } = this.#options;
    const hostId = target.hostId;
    const trusted = await hostKeys.trusted(hostId);
    const credential = target.credentialId
      ? await this.#options.credentials.get(target.credentialId, record.userId)
      : null;
    const mayPrompt = credential?.kind !== 'private_key';
    return new SshTransport({
      host: target.hostname,
      port: target.port,
      username: target.username,
      credential,
      verifyHostKey: (key) => {
        const decision = decideHostKey(trusted, key);
        if (decision === 'trusted' && !trusted.get(key.type)?.publicKeyB64) {
          // A pasted pre-trust fingerprint just matched: keep the key itself from now on.
          hostKeys.rememberPublicKey(hostId, key).catch(() => {});
        }
        hooks.onHostKey(key, decision);
        return decision;
      },
      preferredHostKeyTypes: [...trusted.keys()],
      onKeyboardInteractive: (request) => hooks.onKeyboardInteractive(request),
      keepaliveIntervalMs: Math.max(1, policies.keepaliveIntervalS) * 1000,
      readyTimeoutMs:
        this.#options.readyTimeoutMs ??
        (mayPrompt ? INTERACTIVE_READY_TIMEOUT_MS : DEFAULT_READY_TIMEOUT_MS),
    });
  }
}
