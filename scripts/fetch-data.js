// Stage the published data into public/data/ *before* the build, so the
// deployed snapshot + the postbuild steps (prerender-events, prerender-pages,
// generate-feed, generate-sitemap, generate-csv) have current data without it
// being committed to the repo. Runs automatically as the npm `prebuild` hook.
//
// Where the data comes from, first match wins:
//   DATA_DIR=<path>         a local copy of the collector's output — in CI, a
//                           checkout of the `data` branch. Every published file
//                           is copied into public/data/ so the site serves it
//                           same-origin at /data/.
//   DATA_ORIGIN_URL=<url>   a deployed data origin. The core files are
//                           downloaded into public/data/ (the per-line files
//                           are not; point VITE_DATA_BASE_URL at the origin
//                           when the site should read them from there).
//   (neither)               whatever is already in public/data/ — e.g. from
//                           `npm run collect` during local development.
//
// The site itself reads the bounded files (alerts-recent.json, monthly shards),
// but the postbuild steps need the *all-time* set (per-event OG cards, the
// sitemap, the full CSV). We reassemble it into public/data/alerts.json from
// the monthly shards — they partition every incident by first-seen month —
// unioned with anything the recent slice carries that the shards miss.
//
// If no data exists at all (a fresh clone, or the collector hasn't run yet) we
// write an empty dataset so the build still succeeds; the site then shows no
// incidents until the collector publishes. When DATA_DIR / DATA_ORIGIN_URL was
// set explicitly and fails with no local copy to fall back on, we abort instead
// — deploying an empty archive over a real one is worse than not deploying.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null;
const ORIGIN = process.env.DATA_ORIGIN_URL ? process.env.DATA_ORIGIN_URL.replace(/\/+$/, '') : null;
// Published files fetched from a remote origin besides the shards.
const REMOTE_FILES = [
  'alerts-recent.json',
  'alerts-index.json',
  'daily-counts.json',
  'aggregates.json',
  'accessibility.json',
];

mkdirSync(OUT_DIR, { recursive: true });

function readLocalJson(file) {
  const path = resolve(OUT_DIR, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function fetchJson(file) {
  const res = await fetch(`${ORIGIN}/${file}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

function writeJson(file, value) {
  const path = resolve(OUT_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

// Copy a local data directory wholesale. Skips the repo's own CHANGELOG.md so
// the documented changelog always comes from the site source.
function copyFromDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`DATA_DIR ${dir} is not a directory`);
  }
  if (!existsSync(resolve(dir, 'alerts-recent.json'))) {
    throw new Error(`DATA_DIR ${dir} has no alerts-recent.json`);
  }
  cpSync(dir, OUT_DIR, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(\.git|CHANGELOG\.md|README\.md)$/.test(src),
  });
  console.log(`fetch-data: copied ${dir} -> ${OUT_DIR}`);
}

async function downloadFromOrigin() {
  const index = await fetchJson('alerts-index.json');
  const shards = await Promise.all((index.months ?? []).map((m) => fetchJson(m.url)));
  (index.months ?? []).forEach((m, i) => {
    writeJson(m.url, shards[i]);
  });
  for (const file of REMOTE_FILES) {
    writeJson(file, file === 'alerts-index.json' ? index : await fetchJson(file));
  }
  console.log(`fetch-data: downloaded ${REMOTE_FILES.length + shards.length} files from ${ORIGIN}`);
}

// Rebuild the all-time alerts.json from whatever is now in public/data/.
function assembleAlerts() {
  const index = readLocalJson('alerts-index.json');
  const recent = readLocalJson('alerts-recent.json');
  if (!index && !recent) return null;
  const incidents = [];
  const seen = new Set();
  // index.months is newest-first and each shard preserves first_seen-DESC
  // order, so concatenating in index order yields a global newest-first list.
  for (const month of index?.months ?? []) {
    for (const inc of readLocalJson(month.url)?.incidents ?? []) {
      if (seen.has(inc.id)) continue;
      incidents.push(inc);
      seen.add(inc.id);
    }
  }
  for (const inc of recent?.incidents ?? []) {
    if (!seen.has(inc.id)) incidents.unshift(inc);
  }
  return {
    schema_version: index?.schema_version ?? recent?.schema_version ?? 2,
    generated_at: index?.generated_at ?? recent?.generated_at ?? Date.now(),
    data_start_ts: index?.data_start_ts ?? recent?.data_start_ts ?? null,
    incidents,
  };
}

let explicitSourceFailed = false;
try {
  if (DATA_DIR) copyFromDir(DATA_DIR);
  else if (ORIGIN) await downloadFromOrigin();
} catch (err) {
  explicitSourceFailed = true;
  console.warn(`fetch-data: ${err.message}`);
}

const assembled = assembleAlerts();
if (assembled) {
  writeJson('alerts.json', assembled);
  console.log(`fetch-data: assembled alerts.json (${assembled.incidents.length} incidents)`);
} else if (explicitSourceFailed) {
  console.error('fetch-data: no data available (source failed, no local copy) — aborting build');
  process.exit(1);
} else {
  // Nothing collected yet: publish an empty but well-formed dataset.
  const empty = { schema_version: 2, generated_at: Date.now(), data_start_ts: null, incidents: [] };
  writeJson('alerts.json', empty);
  writeJson('alerts-recent.json', empty);
  console.warn('fetch-data: no collected data found — building with an empty dataset');
}

if (!existsSync(resolve(OUT_DIR, 'accessibility.json'))) {
  writeJson('accessibility.json', {
    schema_version: 1,
    generated_at: Date.now(),
    data_start_ts: null,
    window_days: 180,
    outages: [],
  });
  console.warn('fetch-data: wrote empty accessibility.json fallback');
}
