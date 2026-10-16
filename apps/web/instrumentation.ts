// Boots the auth runtime at server start so the first-run setup token is logged immediately.
// If the daemon has not migrated the database yet, the runtime is built on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    (await import('./lib/auth/server.ts')).getAuthRuntime();
  } catch (error) {
    console.warn(
      '[termdock] auth runtime not ready at boot (is session-manager running and migrated?); it will start on the first request.',
      error instanceof Error ? error.message : error,
    );
  }
}
