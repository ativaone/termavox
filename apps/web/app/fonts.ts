import { Archivo, JetBrains_Mono } from 'next/font/google';

// Downloaded at build time and served from /_next/static: no runtime third-party requests.
// Archivo carries both voices through its width axis: normal for UI, condensed caps for strips.
export const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});

// Codes, keys and secrets only (TOTP key, backup codes); the terminal's own font comes later.
export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});
