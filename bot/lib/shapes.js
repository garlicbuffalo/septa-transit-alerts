// Route shapes for the bots' maps. The collector writes them to the cache
// whenever it rebuilds its daily schedule index; on a fresh server (or one
// that updated mid-day) they're built here from a direct GTFS download.
import { mkdir, rename, writeFile } from 'node:fs/promises';
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
