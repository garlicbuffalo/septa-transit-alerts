// Route shapes for the bots' maps. The collector writes them to the cache
// whenever it rebuilds its daily schedule index; on a fresh server (or one
// that updated mid-day) they're built here from a direct GTFS download.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadBusFeed } from '../../collector/lib/schedule.js';
import {
  buildRouteShapes,
  loadRouteShapes,
  RouteShapes,
  SHAPES_FILE,
} from '../../collector/lib/shapes.js';

/**
 * Load cached shapes, building them if they're missing.
 * @returns {Promise<RouteShapes | null>}
 */
export async function ensureRouteShapes({ cacheDir, fixturesDir = null, log = () => {} }) {
  const cached = await loadRouteShapes({ cacheDir, fixturesDir });
  if (cached || fixturesDir) return cached;
  try {
    const data = buildRouteShapes(await downloadBusFeed());
    await mkdir(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `${SHAPES_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, join(cacheDir, SHAPES_FILE));
    log(`shapes: built ${Object.keys(data.routes).length} routes from GTFS`);
    return new RouteShapes(data);
  } catch (err) {
    log(`shapes: unavailable (${err.message}); detection maps will be text-only`);
    return null;
  }
}

/**
 * When the collector last rewrote the cached shapes (a rebuild of its daily GTFS cache), or null
 * when there is no cache file to watch (fixtures, or none built yet).
 * @returns {Promise<number | null>}
 */
export async function shapesFileStamp({ cacheDir, fixturesDir = null }) {
  if (fixturesDir) return null;
  try {
    return (await stat(join(cacheDir, SHAPES_FILE))).mtimeMs;
  } catch {
    return null;
  }
}
