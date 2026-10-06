// Generate dist/data/alerts.csv — a flat CSV mirror of alerts.json for
// pandas / spreadsheet users who don't want to wrangle the JSON shape.
// Combines alerts and observations into one row per record with a `type`
// column to distinguish them. Columns are stable (defined in src/lib/csv.js,
// shared with the in-browser "Download filtered CSV" button), so a
// downstream pipeline can pin to this layout.
//
// Runs as a postbuild step alongside generate-feed.js / generate-sitemap.js.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsv } from '../src/lib/csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const DATA = resolve(DIST, 'data', 'alerts.json');
const OUT = resolve(DIST, 'data', 'alerts.csv');

function main() {
  if (!existsSync(DATA)) {
    console.warn(`generate-csv: ${DATA} missing — skipping`);
    return;
  }
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  raw.incidents = raw.incidents || [];
  const csv = buildCsv(raw.incidents);
  writeFileSync(OUT, csv);
  const rowCount = raw.incidents.reduce(
    (sum, inc) => sum + (inc.official_alert ? 1 : 0) + (inc.detections || []).length,
    0,
  );
  console.log(`generate-csv: wrote ${rowCount} rows to ${OUT}`);
}

main();
