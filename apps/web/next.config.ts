import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// Document routes get their nonce CSP from proxy.ts; these apply to every response, including
// everything Caddy proxies to web (it passes them through unchanged).
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // No page needs these browser features; nothing embedded may ask for them either.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  // Pages opened from Termdock (terminal links already use noopener) cannot script it back.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  // Self-contained server for the Docker image (deploy/docker/web.Dockerfile).
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages and node_modules are included.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // Workspace packages ship TypeScript sources.
  transpilePackages: [
    '@termdock/db',
    '@termdock/protocol',
    '@termdock/shared',
    '@termdock/terminal-config',
  ],
  // Native module: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default withNextIntl(config);
