import localFont from 'next/font/local';

// Fonts come from the @fontsource-variable npm packages (OFL), so builds never reach a font CDN;
// next/font self-hosts them under /_next/static with no runtime third-party requests.
// Plus Jakarta Sans is the UI face (plan D-26). The latin subset covers U+0000–00FF, so every
// Portuguese diacritic is in it; latin-ext is not loaded.
export const jakarta = localFont({
  src: '../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2',
  weight: '200 800',
  style: 'normal',
  variable: '--font-jakarta',
  display: 'swap',
});

// Codes, keys and secrets only (TOTP key, backup codes); the terminal font is a preference.
export const jetbrainsMono = localFont({
  src: '../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-jetbrains',
  display: 'swap',
});
