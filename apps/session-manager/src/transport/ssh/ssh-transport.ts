import { Socket } from 'node:net';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import type { ClientChannel, ConnectConfig, KeyboardInteractiveCallback, Prompt } from 'ssh2';
import ssh2 from 'ssh2';
import type {
  CredentialSecret,
  ExecChannel,
  PtyChannel,
  PtyOptions,
  SftpSession,
  Transport,
} from '../../core/types.ts';
import { TransportError } from '../../core/types.ts';
import { SshExecChannel, SshPtyChannel } from './channel.ts';
import {
  describeHostKey,
  type HostKeyDecision,
  type HostKeyInfo,
  hostKeyAlgorithms,
} from './host-key.ts';
import {
  decideKeyboardInteractive,
  type KeyboardInteractiveRequest,
} from './keyboard-interactive.ts';
import { openSshSftp } from './sftp.ts';
import type { TargetPolicy } from './target-policy.ts';

const { Client } = ssh2;

export const DEFAULT_READY_TIMEOUT_MS = 20_000;
/** Callers pass this when a keyboard-interactive prompt may wait for a human (plan §5.10). */
export const INTERACTIVE_READY_TIMEOUT_MS = 110_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
export const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const CLOSE_GRACE_MS = 2_000;

export interface SshTransportOptions {
  host: string;
  port: number;
  username: string;
  credential: CredentialSecret | null;
  /** Host-key policy (plan §5.9). Never hold the handshake open for a human. */
  verifyHostKey: (key: HostKeyInfo) => HostKeyDecision | Promise<HostKeyDecision>;
  /** Key types the host already has trusted keys for: negotiated first (plan §5.9). */
  preferredHostKeyTypes?: readonly string[];
  /**
   * Relays a keyboard-interactive round to the user. Resolves with the answers, or null when the
   * prompt expired or was cancelled (→ AUTH_TIMEOUT).
   */
  onKeyboardInteractive?: (req: KeyboardInteractiveRequest) => Promise<string[] | null>;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
  /**
   * SSH target policy (plan §10.2): the daemon resolves the host itself and connects only to
   * an address the policy allows (TARGET_NOT_ALLOWED otherwise). Unset: connects as given.
   */
  targetPolicy?: TargetPolicy;
}

type ConnectFailure =
  | { kind: 'host-key'; decision: 'unknown' | 'mismatch' | 'revoked'; key: HostKeyInfo }
  | { kind: 'host-key-error'; message: string }
  | { kind: 'ki-rejected' }
  | { kind: 'ki-timeout' };

interface SshError extends Error {
  level?: string;
}

/** Transport over SSH (ssh2). Secrets are only handed to ssh2; nothing here logs. */
export class SshTransport implements Transport {
  readonly #options: SshTransportOptions;
  #client: InstanceType<typeof Client> | null = null;
  #state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
  #closing = false;
  #lostFired = false;
  #lastError: Error | null = null;
  readonly #lostCallbacks: Array<(err: TransportError) => void> = [];
  #closed: Promise<void> = Promise.resolve();

  constructor(options: SshTransportOptions) {
    this.#options = options;
  }

  connect(signal: AbortSignal): Promise<void> {
    if (this.#state !== 'idle') {
      return Promise.reject(new Error(`SshTransport.connect() called in state ${this.#state}`));
    }
    if (signal.aborted) return Promise.reject(abortReason(signal));
    this.#state = 'connecting';
    const options = this.#options;
    const client = new Client();
    this.#client = client;
    this.#closed = new Promise((resolve) => client.once('close', () => resolve()));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let failure: ConnectFailure | null = null;
      let hostVerified = false;
      let kiAutoAnswered = false;
      let kiPending = false;

      const settle = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (err) {
          this.#state = 'closed';
          client.removeAllListeners('ready');
          client.end();
          reject(err);
        } else {
          this.#state = 'ready';
          resolve();
        }
      };
      const onAbort = (): void => settle(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });

      const config: ConnectConfig = {
        host: options.host,
        port: options.port,
        username: options.username,
        tryKeyboard: true,
        readyTimeout: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        keepaliveInterval: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: options.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
        hostVerifier: (blob: Buffer, verify: (valid: boolean) => void): void => {
          let key: HostKeyInfo;
          try {
            key = describeHostKey(blob);
          } catch (err) {
            failure = { kind: 'host-key-error', message: (err as Error).message };
            verify(false);
            return;
          }
          Promise.resolve()
            .then(() => options.verifyHostKey(key))
            .then(
              (decision) => {
                if (decision === 'trusted') {
                  hostVerified = true;
                  verify(true);
                } else {
                  failure = { kind: 'host-key', decision, key };
                  verify(false);
                }
              },
              (err: unknown) => {
                failure = { kind: 'host-key-error', message: String(err) };
                verify(false);
              },
            );
        },
      };
      config.algorithms = {
        serverHostKey: hostKeyAlgorithms(options.preferredHostKeyTypes ?? []),
      };
      const credential = options.credential;
      if (credential?.kind === 'password') config.password = credential.password;
      if (credential?.kind === 'private_key') {
        config.privateKey = credential.privateKey;
        if (credential.passphrase !== undefined) config.passphrase = credential.passphrase;
      }

      client.on(
        'keyboard-interactive',
        (
          name: string,
          instructions: string,
          _lang: string,
          prompts: Prompt[],
          finish: KeyboardInteractiveCallback,
        ) => {
          const request: KeyboardInteractiveRequest = {
            name,
            instructions,
            prompts: prompts.map((p) => ({ text: p.prompt, echo: p.echo === true })),
          };
          const relay = options.onKeyboardInteractive;
          const action = decideKeyboardInteractive({
            prompts: request.prompts,
            credential,
            autoAnswered: kiAutoAnswered,
            canRelay: relay !== undefined,
          });
          if (action.kind === 'auto') {
            kiAutoAnswered = true;
            finish(action.answers);
            return;
          }
          if (action.kind === 'reject' || !relay) {
            failure = { kind: 'ki-rejected' };
            settle(
              mapConnectError(new Error('keyboard-interactive'), failure, hostVerified, false),
            );
            return;
          }
          kiPending = true;
          relay(request).then(
            (answers) => {
              kiPending = false;
              if (settled) return;
              if (answers === null) {
                failure = { kind: 'ki-timeout' };
                settle(mapConnectError(new Error('prompt expired'), failure, hostVerified, false));
              } else {
                finish(answers);
              }
            },
            () => {
              kiPending = false;
              failure = { kind: 'ki-rejected' };
              settle(mapConnectError(new Error('relay failed'), failure, hostVerified, false));
            },
          );
        },
      );

      client.once('ready', () => {
        if (settled) return;
        client.on('error', (err: Error) => {
          this.#lastError = err;
        });
        client.on('close', () => this.#handleClose());
        settle(null);
      });
      client.on('error', (err: SshError) => {
        if (!settled) settle(mapConnectError(err, failure, hostVerified, kiPending));
      });
      client.once('close', () => {
        if (!settled) {
          settle(
            mapConnectError(
              new Error('connection closed during handshake'),
              failure,
              hostVerified,
              kiPending,
            ),
          );
        }
      });

      const policy = options.targetPolicy;
      let sock: Socket | null = null;
      if (policy) {
        let target: string;
        try {
          target = policy.target(options.host);
        } catch (err) {
          settle(err as Error);
          return;
        }
        // Our own socket, so that names resolve through the policy's lookup: the address the
        // socket connects to is one the policy allowed, from that same resolution.
        sock = new Socket();
        sock.setMaxListeners(0);
        sock.connect({ host: target, port: options.port, lookup: policy.lookup });
        config.sock = sock;
      }

      try {
        client.connect(config);
      } catch (err) {
        // ssh2 throws synchronously on unparsable keys and wrong passphrases, before it takes
        // over our socket: close it, or it would stay connected to the host.
        sock?.destroy();
        settle(
          new TermavoxError(
            ErrorCode.CredentialInvalid,
            `invalid private key: ${(err as Error).message}`,
          ),
        );
      }
    });
  }

  async exec(command: string): Promise<ExecChannel> {
    const client = this.#readyClient();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream: ClientChannel) => {
        if (err) reject(channelError(err));
        else resolve(new SshExecChannel(stream));
      });
    });
  }

  async openPty(opts: PtyOptions): Promise<PtyChannel> {
    const client = this.#readyClient();
    return new Promise((resolve, reject) => {
      client.shell(
        { term: opts.term, cols: opts.cols, rows: opts.rows, width: 0, height: 0 },
        opts.env ? { env: opts.env } : {},
        (err, stream: ClientChannel) => {
          if (err) reject(channelError(err));
          else resolve(new SshPtyChannel(stream));
        },
      );
    });
  }

  /** An SFTP channel on this connection (plan §5.12); see `openSshSftp` for its errors. */
  async openSftp(): Promise<SftpSession> {
    const client = this.#client;
    if (this.#state !== 'ready' || !client) {
      throw new TermavoxError(ErrorCode.SessionNotConnected, 'the session is not connected');
    }
    return openSshSftp(client, { connected: () => this.#state === 'ready' });
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (!client || this.#closing) return;
    this.#closing = true;
    const wasReady = this.#state === 'ready';
    this.#state = 'closed';
    if (!wasReady) {
      // Idle, failed or still connecting (the pending connect() then rejects).
      client.destroy();
      return;
    }
    client.end();
    const timer = setTimeout(() => client.destroy(), CLOSE_GRACE_MS);
    await this.#closed;
    clearTimeout(timer);
  }

  onLost(cb: (err: TransportError) => void): void {
    this.#lostCallbacks.push(cb);
  }

  #readyClient(): InstanceType<typeof Client> {
    if (this.#state !== 'ready' || !this.#client) {
      throw new TransportError(ErrorCode.HostUnreachable, 'SSH transport is not connected', true);
    }
    return this.#client;
  }

  #handleClose(): void {
    const wasReady = this.#state === 'ready';
    this.#state = 'closed';
    if (this.#closing || !wasReady || this.#lostFired) return;
    this.#lostFired = true;
    const reason = this.#lastError?.message ?? 'connection closed';
    const err = new TransportError('CONNECTION_LOST', `SSH connection lost: ${reason}`, true);
    for (const cb of this.#lostCallbacks) cb(err);
  }
}

function mapConnectError(
  err: SshError,
  failure: ConnectFailure | null,
  hostVerified: boolean,
  kiPending: boolean,
): Error {
  // Refused by the target policy before any connection was made.
  if (err instanceof TermavoxError && err.code === ErrorCode.TargetNotAllowed) return err;
  if (failure?.kind === 'host-key') {
    const { key } = failure;
    if (failure.decision === 'mismatch' || failure.decision === 'revoked') {
      const revoked = failure.decision === 'revoked';
      return new TermavoxError(
        ErrorCode.HostKeyMismatch,
        `host key mismatch: presented ${revoked ? 'revoked ' : ''}${key.type} ${key.fingerprint}`,
        {
          presented: { type: key.type, fingerprint: key.fingerprint },
          ...(revoked ? { revoked: true } : {}),
        },
      );
    }
    return new TermavoxError(
      ErrorCode.HostKeyRejected,
      `unknown host key ${key.type} ${key.fingerprint}`,
      { pending: { type: key.type, fingerprint: key.fingerprint, publicKeyB64: key.publicKeyB64 } },
    );
  }
  if (failure?.kind === 'host-key-error') {
    return new TermavoxError(ErrorCode.HostKeyRejected, `host key rejected: ${failure.message}`);
  }
  if (failure?.kind === 'ki-timeout') {
    return new TermavoxError(ErrorCode.AuthTimeout, 'keyboard-interactive prompt expired');
  }
  if (failure?.kind === 'ki-rejected') {
    return new TermavoxError(
      ErrorCode.AuthRejected,
      'keyboard-interactive prompt cannot be answered',
    );
  }
  if (err.level === 'client-authentication') {
    return new TermavoxError(ErrorCode.AuthRejected, 'authentication rejected');
  }
  if (err.level === 'client-timeout' && (kiPending || hostVerified)) {
    // Host verified but no 'ready' in time: authentication stalled.
    return new TermavoxError(ErrorCode.AuthTimeout, 'authentication timed out');
  }
  return new TransportError(ErrorCode.HostUnreachable, `SSH connect failed: ${err.message}`, true);
}

function channelError(err: Error): TransportError {
  return new TransportError('CHANNEL_FAILED', `SSH channel failed: ${err.message}`, true);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('connect aborted', 'AbortError');
}
