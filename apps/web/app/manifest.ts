import type { MetadataRoute } from 'next';
import icon192 from './_icons/icon-192.png';
import icon512 from './_icons/icon-512.png';
import maskable512 from './_icons/maskable-512.png';

/**
 * The web app manifest: what a browser uses to pin or install Termavox as an app (Firefox's
 * "Add tab to taskbar" reads its icons first and shows a globe without one). The PNGs are
 * rendered from icon.svg (the maskable one full bleed, for launchers that crop to a shape).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Termavox',
    short_name: 'Termavox',
    description: 'Persistent terminal sessions in the browser.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#171431',
    theme_color: '#171431',
    icons: [
      { src: icon192.src, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon512.src, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: maskable512.src, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
