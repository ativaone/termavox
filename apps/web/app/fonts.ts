import localFont from 'next/font/local';

// Fonts come from the @fontsource-variable npm packages (OFL), so builds never reach a font CDN;
// next/font self-hosts them under /_next/static with no runtime third-party requests.
// Archivo carries both voices through its width axis: normal for UI, condensed caps for strips.
export const archivo = localFont({
  src: '../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-archivo',
  display: 'swap',
  declarations: [{ prop: 'font-stretch', value: '62% 125%' }],
});

// Codes, keys and secrets only (TOTP key, backup codes); the terminal font is a preference.
export const jetbrainsMono = localFont({
  src: '../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-jetbrains',
  display: 'swap',
});
