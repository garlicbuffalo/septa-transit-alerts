// Prerender minimal HTML stubs for the static, non-data-driven SPA routes
// (/about, /subscribe, /privacy). Unlike the line/route/station pages, these
// aren't covered by prerender-pages.js, so without a real index.html they would
// 404 for crawlers and inherit the homepage's canonical. Emit a self-canonical
// stub each so they return 200, carry their own title/description, and are safe
// to list in the sitemap. They reuse the homepage OG card — no per-page image.
//
// Runs in postbuild after `vite build` has produced dist/index.html (the shell).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_NAME, SITE_ORIGIN } from '../src/lib/site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const SHELL = resolve(DIST, 'index.html');
const SITE = SITE_ORIGIN;

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PAGES = [
  {
    path: '/about',
    title: 'About',
    desc: `About ${SITE_NAME} — an unofficial public archive of SEPTA service alerts and detected disruptions, and where the data comes from.`,
  },
  {
    path: '/subscribe',
    title: 'Subscribe',
    desc: 'Subscribe to SEPTA service-alert feeds — a global Atom/JSON feed plus a feed for every SEPTA Metro line, bus route, and Regional Rail line.',
  },
  {
    path: '/privacy',
    title: 'Privacy',
    desc: `Privacy policy for ${SITE_NAME}: no accounts, no cookies, no advertising, and no analytics.`,
  },
  // Note: Regional Rail line pages and /system/rail are prerendered by
  // prerender-pages.js (which runs before this step) with their own OG cards,
  // so they're intentionally NOT listed here — re-adding them would clobber
  // those richer stubs with the homepage-card variant.
];

const shell = readFileSync(SHELL, 'utf8');

for (const page of PAGES) {
  const url = `${SITE}${page.path}`;
  const title = `${page.title} · ${SITE_NAME}`;
  const html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escAttr(url)}" />`)
    .replace(
      /<meta name="description"[^>]*>/,
      `<meta name="description" content="${escAttr(page.desc)}" />`,
    )
    .replace(
      /<meta property="og:title"[^>]*>/,
      `<meta property="og:title" content="${escAttr(title)}" />`,
    )
    .replace(
      /<meta property="og:description"[^>]*>/,
      `<meta property="og:description" content="${escAttr(page.desc)}" />`,
    )
    .replace(
      /<meta property="og:url"[^>]*>/,
      `<meta property="og:url" content="${escAttr(url)}" />`,
    )
    .replace(
      /<meta name="twitter:title"[^>]*>/,
      `<meta name="twitter:title" content="${escAttr(title)}" />`,
    )
    .replace(
      /<meta name="twitter:description"[^>]*>/,
      `<meta name="twitter:description" content="${escAttr(page.desc)}" />`,
    );
  const outDir = resolve(DIST, page.path.slice(1));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'index.html'), html);
}

console.log(`prerender-static: wrote ${PAGES.length} static page stubs`);
