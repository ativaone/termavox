/**
 * session-manager entry point: `node src/main.ts` (Node 24 runs TypeScript directly).
 *
 * Boot (plan §5.8): parse the environment → take the data directory lock (one session-manager
 * per database; `vault rotate` takes it too) → open the DB (busy_timeout 250 ms) → migrate →
 * ensure `installation_id` → load and verify the vault KEK (`vault_key_check`, at its key
 * version) → read the WS secret and internal token files → data plane (WebSocket server + boot
 * restore) → internal API → event retention job (first purge a few minutes later). SIGTERM/SIGINT
 * → graceful shutdown within 25 s: retention job, internal API, data plane (runtimes detach,
 * clients are told the server is restarting), batched writer flush, DB close, lock release.
 */
import type { AddressInfo } from 'node:net';
import { migrateDb, openDb, type TermdockDb } from '@termdock/db';
import pkg from '../package.json' with { type: 'json' };
import { type DaemonConfig, loadDaemonConfig, readSecretFile } from './config/config.ts';
import { createLogger, type Logger } from './config/logger.ts';
import { createDataPlane, type DataPlane, type DataPlaneDeps } from './core/data-plane.ts';
import { SshTransportFactory } from './core/transport-factory.ts';
import { TmuxControlDriver } from './drivers/tmux-control/index.ts';
import { cachedFileSettings } from './files/settings.ts';
import { InternalApi, type InternalApiOptions } from './internal-api/server.ts';
import { SqliteAuthSessionValidator, SqliteOwnership } from './store/access.ts';
import { insertAudit } from './store/audit.ts';
import { BatchedWriter } from './store/batched-writer.ts';
import { lockDataDir } from './store/data-dir-lock.ts';
import { auditHostKeyMismatches, SqliteHostKeyStore } from './store/host-key-store.ts';
import { RetentionJob, type RetentionJobOptions } from './store/retention.ts';
import { SqliteSessionStore } from './store/session-store.ts';
import { ensureInstallationId, readFileSettings } from './store/settings.ts';
import { TargetPolicy } from './transport/ssh/index.ts';
import { CredentialService, VaultCredentialProvider } from './vault/credentials.ts';
import { openVault } from './vault/vault.ts';

/** Daemon shutdown budget, inside compose's `stop_grace_period: 30s`. */
export const SHUTDOWN_BUDGET_MS = 25_000;
/** The daemon's own lock wait; the batched writer retries beyond it (plan §9). */
export const DAEMON_BUSY_TIMEOUT_MS = 250;
export const VERSION: string = pkg.version;

export interface DaemonOverrides {
  logger?: Logger;
  /** Test timings. */
  registry?: DataPlaneDeps['registry'];
  wsOptions?: DataPlaneDeps['wsOptions'];
  serverTest?: InternalApiOptions['serverTest'];
  remoteSessions?: InternalApiOptions['remoteSessions'];
  retention?: Pick<RetentionJobOptions, 'initialDelayMs' | 'intervalMs' | 'chunkRows' | 'now'>;
}

export interface Daemon {
  config: DaemonConfig;
  db: TermdockDb;
  writer: BatchedWriter;
  installationId: string;
  sessions: SqliteSessionStore;
  hostKeys: SqliteHostKeyStore;
  credentials: CredentialService;
  plane: DataPlane;
  internalApi: InternalApi;
  /** Audit and session-event purge (TERMDOCK_EVENT_RETENTION_DAYS). */
  retention: RetentionJob;
  wsAddress: AddressInfo;
  internalAddress: AddressInfo;
  /** Resolves when boot restore has started every restorable session. */
  restored: Promise<void>;
  /** Graceful shutdown (idempotent), bounded by `budgetMs`. */
  shutdown(budgetMs?: number): Promise<void>;
}

/** Boots the daemon wiring in-process (also used by the T1 daemon test). */
export async function startDaemon(
  config: DaemonConfig,
  overrides: DaemonOverrides = {},
): Promise<Daemon> {
  const log = overrides.logger ?? createLogger(config.logLevel);
  // Held until the shutdown completes; a crash releases it with the process.
  const lock = lockDataDir(config.dbFile);
  let db: TermdockDb;
  try {
    db = openDb(config.dbFile, { busyTimeoutMs: DAEMON_BUSY_TIMEOUT_MS });
  } catch (err) {
    lock.release();
    throw err;
  }
  const writer = new BatchedWriter(db, { logger: log });
  let plane: DataPlane | null = null;
  let internalApi: InternalApi | null = null;
  try {
    migrateDb(db);
    const installationId = await ensureInstallationId(writer);
    const { vault, keyCheck: vaultKeyCheck } = await openVault(writer, config.masterKeyFile);
    const wsSecret = await readSecretFile(config.wsSecretFile);
    const internalToken = await readSecretFile(config.internalTokenFile);

    const sessions = new SqliteSessionStore(db, writer);
    const hostKeys = new SqliteHostKeyStore(db, writer);
    const credentialProvider = new VaultCredentialProvider({ db, writer, vault });
    const credentials = new CredentialService({ db, writer, vault });
    const ownership = new SqliteOwnership(db);
    // One policy for sessions and server tests (plan §10.2).
    const targetPolicy = new TargetPolicy({ allowLocalTargets: config.sshAllowLocalTargets });
    plane = createDataPlane({
      publicOrigin: config.publicOrigin,
      ws: { host: config.wsHost, port: config.wsPort, trustedProxies: config.trustedProxies },
      wsSecret,
      installationId,
      store: sessions,
      remoteLookup: sessions,
      hostKeys,
      credentials: credentialProvider,
      ownership,
      authSessions: new SqliteAuthSessionValidator(db),
      transports: auditHostKeyMismatches(
        new SshTransportFactory({ hostKeys, credentials: credentialProvider, targetPolicy }),
        hostKeys,
      ),
      tmuxControl: (opts) => new TmuxControlDriver(opts),
      // File panel (plan §5.12): web's settings, read through a 2 s cache; audit rows queued.
      files: {
        settings: cachedFileSettings(() => readFileSettings(db.$client), {
          onError: (err) => log.warn({ err }, 'file settings not read'),
        }),
        audit: (input) => writer.enqueue(input.type, (sqlite) => insertAudit(sqlite, input)),
      },
      logger: log,
      ...(overrides.registry ? { registry: overrides.registry } : {}),
      ...(overrides.wsOptions ? { wsOptions: overrides.wsOptions } : {}),
    });
    const { address: wsAddress, restored } = await plane.start();
    internalApi = new InternalApi({
      host: config.internalHost,
      port: config.internalPort,
      token: internalToken,
      db,
      sessions,
      hostKeys,
      credentials,
      credentialProvider,
      ownership,
      registry: plane.registry,
      connections: plane.ws,
      enableLocalShell: config.enableLocalShell,
      targetPolicy,
      installationId,
      version: VERSION,
      logger: log,
      ...(overrides.serverTest ? { serverTest: overrides.serverTest } : {}),
      ...(overrides.remoteSessions ? { remoteSessions: overrides.remoteSessions } : {}),
    });
    const internalAddress = await internalApi.listen();
    log.info(
      {
        version: VERSION,
        installationId,
        vaultKeyCheck,
        vaultKeyVersion: vault.currentVersion,
        ws: `${wsAddress.address}:${wsAddress.port}`,
        internalApi: `${internalAddress.address}:${internalAddress.port}`,
        dataDir: config.dataDir,
      },
      'session-manager ready',
    );
    const restoreDone = restored.then((summary) => {
      if (!summary) return;
      // Plan §5.8: how many sessions boot restore reattached (started), and how many the previous
      // daemon left ending (ended now; their tmux, if any is left, goes at the next connection).
      log.info(
        { restored: summary.restored, endedInterrupted: summary.endedInterrupted },
        'boot restore finished',
      );
    });
    const retention = new RetentionJob({
      writer,
      retentionDays: config.eventRetentionDays,
      logger: log,
      ...overrides.retention,
    });
    retention.start();

    const runningPlane = plane;
    const runningApi = internalApi;
    let stopping: Promise<void> | null = null;
    const shutdown = (budgetMs = SHUTDOWN_BUDGET_MS): Promise<void> => {
      stopping ??= (async () => {
        const deadline = Date.now() + budgetMs;
        log.info('shutting down');
        // No purge chunk starts after this; one already queued commits with the final flush.
        void retention.stop();
        await runningApi.close().catch((err) => log.warn({ err }, 'internal API close failed'));
        await runningPlane
          .shutdown()
          .catch((err) => log.warn({ err }, 'data plane shutdown failed'));
        // Runtimes persist their last states during the data plane shutdown: flush after it.
        const drained = await writer.close(Math.max(1_000, deadline - Date.now()));
        // Plan §5.8: protected sessions survive the stop on their servers, by design (D-30).
        try {
          log.info(
            { sessions: sessions.countReattachable() },
            'tmux-protected sessions keep running on their servers; the next start reattaches them',
          );
        } catch (err) {
          log.warn({ err }, 'could not count the sessions that keep running');
        }
        db.$client.close();
        lock.release();
        log.info({ drained }, 'shutdown complete');
      })();
      return stopping;
    };
    return {
      config,
      db,
      writer,
      installationId,
      sessions,
      hostKeys,
      credentials,
      plane: runningPlane,
      internalApi: runningApi,
      retention,
      wsAddress,
      internalAddress,
      restored: restoreDone,
      shutdown,
    };
  } catch (err) {
    await internalApi?.close().catch(() => {});
    await plane?.shutdown().catch(() => {});
    await writer.close(1_000).catch(() => false);
    db.$client.close();
    lock.release();
    throw err;
  }
}

async function main(): Promise<void> {
  let config: DaemonConfig;
  try {
    config = loadDaemonConfig();
  } catch (err) {
    console.error(`termdock session-manager: ${(err as Error).message}`);
    process.exit(1);
  }
  const log = createLogger(config.logLevel);
  const exit = (code: number): void => log.flush(() => process.exit(code));
  let daemon: Daemon;
  try {
    daemon = await startDaemon(config, { logger: log });
  } catch (err) {
    log.fatal({ err }, 'boot failed');
    exit(1);
    return;
  }
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutdown requested');
    const timer = setTimeout(() => {
      log.error({ budgetMs: SHUTDOWN_BUDGET_MS }, 'shutdown budget exceeded; exiting');
      exit(1);
    }, SHUTDOWN_BUDGET_MS);
    timer.unref();
    daemon.shutdown(SHUTDOWN_BUDGET_MS - 1_000).then(
      () => exit(0),
      (err: unknown) => {
        log.error({ err }, 'shutdown failed');
        exit(1);
      },
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) void main();
