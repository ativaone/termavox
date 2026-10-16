import type { AddressInfo } from 'node:net';
import { type Logger, silentLogger } from '../config/logger.ts';
import { TargetPolicy } from '../transport/ssh/index.ts';
import { WsServer, type WsServerOptions } from '../ws/server.ts';
import type { AuthSessionValidator } from '../ws/types.ts';
import { createDriverFactory, type TmuxControlDriverOptions } from './driver-factory.ts';
import { SessionRegistry, type SessionRegistryOptions } from './session-registry.ts';
import { SshTransportFactory, type TransportFactory } from './transport-factory.ts';
import type {
  CredentialProvider,
  Driver,
  HostKeyStore,
  OwnershipCheck,
  SessionStore,
} from './types.ts';

export interface DataPlaneDeps {
  publicOrigin: string;
  /** `trustedProxies`: TERMDOCK_TRUSTED_PROXIES (default: trust no X-Forwarded-For). */
  ws: { host: string; port: number; trustedProxies?: readonly string[] };
  wsSecret: Uint8Array;
  installationId: string;
  store: SessionStore;
  hostKeys: HostKeyStore;
  credentials: CredentialProvider;
  ownership: OwnershipCheck;
  authSessions: AuthSessionValidator;
  /** `(opts) => new TmuxControlDriver(opts)`; without it sessions run unprotected. */
  tmuxControl?: (opts: TmuxControlDriverOptions) => Driver;
  transports?: TransportFactory;
  /** For the default transport factory; default: local targets refused (plan §10.2). */
  targetPolicy?: TargetPolicy;
  logger?: Logger;
  /** Test timings. */
  registry?: Pick<SessionRegistryOptions, 'runtime' | 'restoreHostSpacingMs'>;
  wsOptions?: Pick<WsServerOptions, 'helloTimeoutMs' | 'revalidateIntervalMs' | 'nonces'>;
}

export interface DataPlane {
  registry: SessionRegistry;
  ws: WsServer;
  /** Listens for WebSockets, then restores sessions in the background. */
  start(): Promise<{ address: AddressInfo; restored: Promise<void> }>;
  /** Graceful shutdown (plan §5.8). */
  shutdown(): Promise<void>;
}

/** Assembles the session registry and the WebSocket server from injected stores. */
export function createDataPlane(deps: DataPlaneDeps): DataPlane {
  const logger = deps.logger ?? silentLogger();
  let ws: WsServer | null = null;
  const registry = new SessionRegistry({
    store: deps.store,
    hostKeys: deps.hostKeys,
    transports:
      deps.transports ??
      new SshTransportFactory({
        hostKeys: deps.hostKeys,
        credentials: deps.credentials,
        targetPolicy: deps.targetPolicy ?? new TargetPolicy({ allowLocalTargets: false }),
      }),
    drivers: createDriverFactory(deps.tmuxControl),
    notifier: { sendToUser: (userId, message) => ws?.sendToUser(userId, message) },
    installationId: deps.installationId,
    logger,
    ...deps.registry,
  });
  ws = new WsServer({
    host: deps.ws.host,
    port: deps.ws.port,
    ...(deps.ws.trustedProxies ? { trustedProxies: deps.ws.trustedProxies } : {}),
    publicOrigin: deps.publicOrigin,
    secret: deps.wsSecret,
    authSessions: deps.authSessions,
    ownership: deps.ownership,
    sessions: registry,
    logger,
    ...deps.wsOptions,
  });
  const server = ws;
  return {
    registry,
    ws: server,
    async start() {
      const address = await server.listen();
      const restored = registry.restore().catch((err) => {
        logger.error({ err }, 'boot restore failed');
      });
      return { address, restored };
    },
    async shutdown() {
      server.beginShutdown();
      await registry.shutdown();
      await server.close();
    },
  };
}
