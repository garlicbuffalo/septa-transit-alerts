// Render the committed raster brand assets from their sources with Playwright:
//
//   scripts/og-template.html   → public/og-image.png (1200×630 homepage card)
//   public/favicon.svg         → public/favicon-16.png, public/favicon-32.png
//   public/apple-touch-icon.svg → public/apple-touch-icon.png (180×180)
//   scripts/icon-maskable.svg  → public/icon-maskable-192.png, -512.png
//
// Run with `npm run brand-assets` after editing any of the sources, and commit
// the PNGs. The OG card's footer URL comes from SITE_URL (src/lib/site.js), so
// re-run this when the site's domain changes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_ORIGIN } from '../src/lib/site.js';
import { launchChromium } from './browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE_HOST = new URL(SITE_ORIGIN).host;

const ICONS = [
  { src: 'public/favicon.svg', out: 'public/favicon-16.png', size: 16 },
  { src: 'public/favicon.svg', out: 'public/favicon-32.png', size: 32 },
  { src: 'public/apple-touch-icon.svg', out: 'public/apple-touch-icon.png', size: 180 },
  { src: 'scripts/icon-maskable.svg', out: 'public/icon-maskable-192.png', size: 192 },
  { src: 'scripts/icon-maskable.svg', out: 'public/icon-maskable-512.png', size: 512 },
];

function svgPage(svg, size) {
  // Inline the SVG at the target size on a transparent page.
  const sized = svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  return `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`;
}

const browser = await launchChromium();
try {
  // The card is laid out at 1024×538 CSS px; scale it up to 1200×630.
  const og = await browser.newPage({
    viewport: { width: 1024, height: 538 },
    deviceScaleFactor: 1200 / 1024,
  });
  const ogHtml = readFileSync(resolve(ROOT, 'scripts/og-template.html'), 'utf8').replaceAll(
    '__SITE_HOST__',
    SITE_HOST,
  );
  await og.setContent(ogHtml, { waitUntil: 'load' });
  await og.screenshot({
    path: resolve(ROOT, 'public/og-image.png'),
    clip: { x: 0, y: 0, width: 1024, height: 538 },
  });
  console.log('Wrote public/og-image.png (1200x630)');

  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(svgPage(readFileSync(resolve(ROOT, icon.src), 'utf8'), icon.size));
    await page.screenshot({
      path: resolve(ROOT, icon.out),
      omitBackground: true,
      clip: { x: 0, y: 0, width: icon.size, height: icon.size },
    });
    await page.close();
    console.log(`Wrote ${icon.out} (${icon.size}x${icon.size})`);
  }
} finally {
  await browser.close();
}
