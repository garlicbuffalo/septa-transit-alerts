// The last postbuild step: take out of dist/ what only the build needed.
//
// data/alerts.json is the whole archive in one file, put together by
// fetch-data.js for the steps before this one (event stubs, feeds, the sitemap,
// the CSV). The site itself reads the recent slice and the monthly shards, so
// publishing it would only add a copy of everything, growing with the archive.
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BUILD_ONLY = ['data/alerts.json'];

for (const rel of BUILD_ONLY) {
  const path = resolve(DIST, rel);
  if (!existsSync(path)) continue;
  const mb = (statSync(path).size / 1048576).toFixed(1);
  rmSync(path);
  console.log(`finish-build: removed ${rel} (${mb} MB, build-only)`);
}
