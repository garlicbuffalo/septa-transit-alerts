// Write the site's map style, public/maps/dark-matter.json: CARTO's
// dark-matter vector style recoloured by src/lib/darkMatterStyle.js. Run by
// hand (`npm run map-style`) when that file changes, or to take up a change in
// CARTO's style (`npm run map-style -- --fetch`); both files are committed.
//
// CARTO's style as fetched is kept beside this script
// (carto-dark-matter-style.json), so the build works offline and a test can
// check the committed style is what darkMatterStyle() makes of it.
// CARTO_KEY, if set, goes on the request (CARTO serves its styles without one
// today, but may not always); CARTO_REFERER for a key limited to a domain.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkMatterStyle } from '../src/lib/darkMatterStyle.js';

const SOURCE = 'https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const here = dirname(fileURLToPath(import.meta.url));
const snapshot = resolve(here, 'carto-dark-matter-style.json');
const out = resolve(here, '../public/maps/dark-matter.json');

if (process.argv.includes('--fetch')) {
  const url = new URL(SOURCE);
  if (process.env.CARTO_KEY) url.searchParams.set('key', process.env.CARTO_KEY);
  const headers = process.env.CARTO_REFERER ? { referer: process.env.CARTO_REFERER } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CARTO's style: HTTP ${res.status}`);
  writeFileSync(snapshot, `${JSON.stringify(await res.json(), null, 1)}\n`);
  console.log(`fetched ${SOURCE} into ${snapshot}`);
}
const style = darkMatterStyle(JSON.parse(readFileSync(snapshot, 'utf8')));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(style, null, 1)}\n`);
console.log(`wrote ${out} (${style.layers.length} layers)`);
