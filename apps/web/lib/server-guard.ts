// Runtime stand-in for the `server-only` package, which is not a dependency: Vitest cannot resolve
// it, so modules shared with tests import this guard instead. The Next-facing entry
// (lib/auth/server.ts) also imports `server-only`, which Next turns into a build-time check.
if (typeof window !== 'undefined') {
  throw new Error('a server-only Termdock module was imported in a browser bundle');
}

export {};
