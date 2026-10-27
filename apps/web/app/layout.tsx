import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { requestTheme } from '../lib/preferences/request-theme.ts';
import { THEME_SWATCHES } from '../lib/preferences/theme.ts';
import { jakarta, jetbrainsMono } from './fonts.ts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Termavox', template: '%s · Termavox' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

/** The browser's bar and first paint follow the theme (plan D-55); System lets the device pick. */
export async function generateViewport(): Promise<Viewport> {
  const theme = await requestTheme();
  const base = { width: 'device-width', initialScale: 1, viewportFit: 'cover' } as const;
  if (theme === 'system') {
    return {
      ...base,
      themeColor: [
        { media: '(prefers-color-scheme: light)', color: THEME_SWATCHES.light.ground },
        { media: '(prefers-color-scheme: dark)', color: THEME_SWATCHES.dark.ground },
      ],
      colorScheme: 'dark light',
    };
  }
  return { ...base, themeColor: THEME_SWATCHES[theme].ground, colorScheme: theme };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const theme = await requestTheme();
  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${jakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
