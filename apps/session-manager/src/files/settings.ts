/**
 * The file panel's instance settings (plan §5.12). Web owns and writes them; the daemon reads them
 * through a short cache, so an administrator's change applies within a couple of seconds.
 */
export interface FileSettings {
  /** `file_transfer_enabled`: off answers every file request FILES_DISABLED. */
  transferEnabled: boolean;
  /** `file_audit_enabled`: file operations are written to `audit_events`. */
  auditEnabled: boolean;
}

/** Defaults when nothing is stored: transfer on, audit off. */
export const DEFAULT_FILE_SETTINGS: FileSettings = { transferEnabled: true, auditEnabled: false };
export const FILE_SETTINGS_CACHE_MS = 2_000;

/** `load` at most once per `ttlMs`; a failing load keeps the last value (defaults at first). */
export function cachedFileSettings(
  load: () => FileSettings,
  options: { ttlMs?: number; now?: () => number; onError?: (err: unknown) => void } = {},
): () => FileSettings {
  const ttlMs = options.ttlMs ?? FILE_SETTINGS_CACHE_MS;
  const now = options.now ?? Date.now;
  let value = DEFAULT_FILE_SETTINGS;
  let loadedAt = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - loadedAt < ttlMs) return value;
    loadedAt = at;
    try {
      value = load();
    } catch (err) {
      options.onError?.(err);
    }
    return value;
  };
}
