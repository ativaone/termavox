// Browser terminal client (framework-agnostic). The React hooks live in ./react.ts and the
// @xterm/xterm factory in ./xterm.ts (client-only; import it dynamically).
export * from './channel.ts';
export * from './config.ts';
export * from './connection.ts';
export * from './layout.ts';
export * from './paste.ts';
export type * from './types.ts';
