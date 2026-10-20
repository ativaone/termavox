import { ErrorCode, TermavoxError } from '@termavox/shared';
import {
  DEFAULT_READY_TIMEOUT_MS,
  type HostKeyDecision,
  type HostKeyInfo,
  INTERACTIVE_READY_TIMEOUT_MS,
  type KeyboardInteractiveRequest,
  SshTransport,
  type TargetPolicy,
} from '../transport/ssh/index.ts';
import {
  type CredentialProvider,
  type HostKeyStore,
  type PresentedHostKey,
  type SessionRecord,
  sessionHostKeyTarget,
  type Transport,
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
 * Host-key policy against the trusted and revoked keys of an address: a trusted key of the same
 * type and fingerprint → trusted; a fingerprint the owner revoked → revoked (fails closed like a
 * mismatch, even when nothing is trusted any more); no trusted key at all → unknown (prompt);
 * trusted keys exist but none matches (same type with another fingerprint, or only other key
 * types) → mismatch. The last case is deliberately strict: offering a different key type is a
 * classic downgrade attempt. A key that is neither trusted nor revoked after a revocation is
 * unknown again (a server that rotated to a new key).
 */
export function decideHostKey(
  trusted: ReadonlyMap<string, PresentedHostKey>,
  key: HostKeyInfo,
  revoked: ReadonlySet<string> = new Set(),
): HostKeyDecision {
  if (trusted.get(key.type)?.fingerprint === key.fingerprint) return 'trusted';
  if (revoked.has(key.fingerprint)) return 'revoked';
  return trusted.size === 0 ? 'unknown' : 'mismatch';
}

export interface SshTransportFactoryOptions {
  hostKeys: HostKeyStore;
  credentials: CredentialProvider;
  /** Which addresses sessions may connect to (TERMAVOX_SSH_ALLOW_LOCAL_TARGETS). */
  targetPolicy: TargetPolicy;
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
      throw new TermavoxError(ErrorCode.LocalShellDisabled, 'local sessions are not available');
    }
    // The owner's decisions for the session's snapshotted address (plan §5.9, D-29); the runtime
    // never gets here once the server was deleted. Loaded before connect, so the verifier
    // answers synchronously during the handshake.
    const { hostKeys } = this.#options;
    const address = sessionHostKeyTarget(record);
    const trusted = await hostKeys.trusted(address);
    const revoked = await hostKeys.revoked(address);
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
        const decision = decideHostKey(trusted, key, revoked);
        if (decision === 'trusted' && !trusted.get(key.type)?.publicKeyB64) {
          // A pasted pre-trust fingerprint just matched: keep the key itself from now on.
          hostKeys.rememberPublicKey(address, key).catch(() => {});
        }
        hooks.onHostKey(key, decision);
        return decision;
      },
      preferredHostKeyTypes: [...trusted.keys()],
      onKeyboardInteractive: (request) => hooks.onKeyboardInteractive(request),
      targetPolicy: this.#options.targetPolicy,
      keepaliveIntervalMs: Math.max(1, policies.keepaliveIntervalS) * 1000,
      readyTimeoutMs:
        this.#options.readyTimeoutMs ??
        (mayPrompt ? INTERACTIVE_READY_TIMEOUT_MS : DEFAULT_READY_TIMEOUT_MS),
    });
  }
}
