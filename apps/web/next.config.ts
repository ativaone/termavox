import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// Document routes get their nonce CSP from proxy.ts; these apply to every response.
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

const config: NextConfig = {
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
