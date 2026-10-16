import type { Locale } from './i18n/locales.ts';
import type messages from './messages/en.json';

// Typed message keys: a key missing from en.json is a type error (pt-BR parity is a T0 test).
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
