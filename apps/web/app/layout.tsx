import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { jakarta, jetbrainsMono } from './fonts.ts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Termavox', template: '%s · Termavox' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#171431',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${jakarta.variable} ${jetbrainsMono.variable}`}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
