import './server-guard.ts';

/** Minimal logger seam (pino arrives with the rest of the web logging; plan T-11). */
export interface WebLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: WebLogger = {
  info: (message) => console.info(`[termdock] ${message}`),
  warn: (message) => console.warn(`[termdock] WARN ${message}`),
  error: (message) => console.error(`[termdock] ERROR ${message}`),
};
