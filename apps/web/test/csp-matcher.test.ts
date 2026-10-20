import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';

// Next's server modules expect the AsyncLocalStorage global that its own runtime installs; set
// it before they load (static imports would be evaluated first).
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
const { config } = await import('../proxy.ts');

type MatcherConfig = Parameters<typeof unstable_doesMiddlewareMatch>[0]['config'];

const runsProxy = (path: string, headers: Record<string, string> = {}): boolean =>
  unstable_doesMiddlewareMatch({
    config: config as MatcherConfig,
    url: `http://termavox.test${path}`,
    headers,
  });

describe('nonce CSP proxy matcher (plan §10.2)', () => {
  it('runs for every document, including 404s that only start like an excluded path', () => {
    for (const path of [
      '/',
      '/workspace',
      '/login',
      '/apix',
      '/api-docs',
      '/favicon.icox',
      '/_next/imagex',
      '/_next/staticx',
    ]) {
      expect(runsProxy(path), path).toBe(true);
    }
  });

  it('skips API routes (static API policy), static assets and the image optimizer', () => {
    for (const path of [
      '/api',
      '/api/',
      '/api/layout',
      '/api/auth/get-session',
      '/_next/static/chunks/x.js',
      '/_next/image',
      '/_next/image?url=%2Fx.png&w=64&q=75',
      '/favicon.ico',
    ]) {
      expect(runsProxy(path), path).toBe(false);
    }
  });

  it('skips router prefetches', () => {
    expect(runsProxy('/workspace', { 'next-router-prefetch': '1' })).toBe(false);
    expect(runsProxy('/workspace', { purpose: 'prefetch' })).toBe(false);
  });
});
