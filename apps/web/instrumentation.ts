// Boots the auth runtime at server start so the first-run setup token is logged immediately.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs')
    (await import('./lib/auth/server.ts')).getAuthRuntime();
}
