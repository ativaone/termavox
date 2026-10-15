import type { NextConfig } from 'next';

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
};

export default config;
