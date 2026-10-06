// The server's main loop, one job per concern:
//
//   observe      every minute: poll TransitView (buses, trolleys, M1) and
//                TrainView (Regional Rail), record every position
//   collect      every 2 minutes: run the collector on the latest positions,
//                post to Bluesky from its beforePublish hook, link the posts
//                into the data, and publish the data branch
//   housekeeping hourly: prune old observations and dry-run assets
//   backup       nightly: a consistent copy of the database
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../../collector/collect.js';
import { createSources } from '../../collector/lib/sources.js';
import { normalizeTransitView } from '../../collector/lib/vehicles.js';
import { linkAlertPosts, postAlerts } from '../features/alerts.js';
import { postCrossBunching } from '../features/crossBunching.js';
import { linkDetectionPosts, postDetections } from '../features/detections.js';
import { maybePostGhostRollups } from '../features/ghosts.js';
import { renderAlertMap } from '../map/lineMap.js';
import { pruneDb } from './db.js';
import { recordObservations } from './observations.js';
import { ensureRouteShapes } from './shapes.js';

const ASSET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUPS_KEPT = 7;

/**
 * @param {{ config: ReturnType<typeof import('./config.js').loadConfig>,
 *   db: import('better-sqlite3').Database, poster: object, basemap: Function,
 *   publisher: ReturnType<typeof import('./publish.js').createPublisher>,
 *   log?: (m: string) => void, now?: () => number, sources?: object, fetchFn?: typeof fetch }} opts
 */
export function createPipeline({
  config,
  db,
  poster,
  basemap,
  publisher,
  log = console.log,
  now = () => Date.now(),
  sources = createSources({ fixturesDir: config.fixturesDir }),
  fetchFn = fetch,
}) {
  const latest = { transitView: null, trainView: null };
  let shapes = null;

  // Each feature runs on its own: one failing never stops the others (or
  // the data from publishing).
  async function step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      log(`${name}: ${err.stack ?? err.message}`);
      return { error: err.message };
    }
  }

  async function ping(suffix = '') {
    if (!config.healthcheckUrl) return;
    try {
      await fetchFn(`${config.healthcheckUrl}${suffix}`, { signal: AbortSignal.timeout(10000) });
    } catch {}
  }

  return {
    latest,

    /** Load (or build) the route shapes the detection maps draw on. */
    async loadShapes() {
      shapes = await ensureRouteShapes({
        cacheDir: config.cacheDir,
        fixturesDir: config.fixturesDir,
        log,
      });
      return shapes;
    },

    async observe() {
      const t = now();
      const [tv, rr] = await Promise.allSettled([sources.transitView(), sources.trainView()]);
      let vehicles = [];
      if (tv.status === 'fulfilled') {
        latest.transitView = { ts: t, payload: tv.value };
        vehicles = normalizeTransitView(tv.value, t).vehicles;
      } else {
        log(`observe: TransitView failed: ${tv.reason?.message ?? tv.reason}`);
      }
      let trains = [];
      if (rr.status === 'fulfilled' && Array.isArray(rr.value)) {
        latest.trainView = { ts: t, payload: rr.value };
        trains = rr.value;
      } else if (rr.status === 'rejected') {
        log(`observe: TrainView failed: ${rr.reason?.message ?? rr.reason}`);
      }
      const rows = recordObservations(db, t, { vehicles, trains });
      return { vehicles: vehicles.length, trains: trains.length, rows };
    },

    async collectTick() {
      const t = now();
      const maxAge = config.intervals.observeMs * 1.5;
      const fresh = (x) => (x && t - x.ts <= maxAge ? x.payload : null);
      // The TransitView payload this tick actually used, for the post maps.
      let usedTransitView = null;
      const { ok, summary } = await collect({
        dataDir: config.dataDir,
        cacheDir: config.cacheDir,
        fixturesDir: config.fixturesDir,
        now: t,
        log: () => {},
        warn: log,
        sources: {
          transitView: async () => {
            usedTransitView = fresh(latest.transitView) ?? (await sources.transitView());
            return usedTransitView;
          },
          trainView: async () => fresh(latest.trainView) ?? sources.trainView(),
        },
        beforePublish: async ({ incidents, schedule, now: tickNow }) => {
          const vehicleList = usedTransitView
            ? normalizeTransitView(usedTransitView, tickNow).vehicles
            : [];
          const vehicles = new Map();
          for (const v of vehicleList) {
            vehicles.set(String(v.label), v);
            vehicles.set(String(v.id), v);
          }
          const alerts = await step('alerts', () =>
            postAlerts({
              incidents,
              poster,
              now: tickNow,
              maxAgeMs: config.postMaxAgeMs,
              renderMap: (inc) => renderAlertMap(inc, { basemap }),
              log,
            }),
          );
          const detections = await step('detections', () =>
            postDetections({
              incidents,
              poster,
              db,
              vehicles,
              shapes,
              basemap,
              now: tickNow,
              maxAgeMs: config.postMaxAgeMs,
              log,
            }),
          );
          const ghosts = await step('ghosts', () =>
            maybePostGhostRollups({ incidents, poster, db, now: tickNow, log }),
          );
          const crossRoute = await step('cross-bunching', () =>
            postCrossBunching({
              vehicles: vehicleList,
              schedule,
              db,
              poster,
              shapes,
              basemap,
              now: tickNow,
              log,
            }),
          );
          const linked = linkAlertPosts(incidents, poster) + linkDetectionPosts(incidents, poster);
          return { alerts, detections, ghosts, crossRoute, linked };
        },
      });
      let published = null;
      if (ok) {
        try {
          published = await publisher.publish(summary);
        } catch (err) {
          log(`publish failed: ${err.message}`);
          published = { error: err.message };
        }
      }
      const errors = Object.entries(summary.sources)
        .filter(([, s]) => s.error)
        .map(([name, s]) => `${name}: ${s.error}`);
      log(
        `collect: ${summary.active} active, ${summary.changed} changed` +
          (summary.hook?.alerts
            ? `, alerts posted ${summary.hook.alerts.posted ?? 0} cleared ${summary.hook.alerts.cleared ?? 0}`
            : '') +
          (summary.hook?.detections?.posted
            ? `, detections posted ${summary.hook.detections.posted}`
            : '') +
          (summary.hook?.ghosts?.posts
            ? `, ghost rollup ${summary.hook.ghosts.routes} routes`
            : '') +
          (summary.hook?.crossRoute?.posted ? ', cross-route cluster posted' : '') +
          (published?.pushed ? ', pushed' : '') +
          (published?.deployed ? ', deploy triggered' : '') +
          (errors.length ? ` — ${errors.join('; ')}` : ''),
      );
      await ping(ok ? '' : '/fail');
      return { ok, summary, published };
    },

    async housekeeping() {
      const pruned = pruneDb(db, now(), config);
      let assets = 0;
      try {
        for (const day of await readdir(config.assetsDir)) {
          const dir = join(config.assetsDir, day);
          if (now() - (await stat(dir)).mtimeMs > ASSET_MAX_AGE_MS) {
            await rm(dir, { recursive: true, force: true });
            assets++;
          }
        }
      } catch {}
      return { ...pruned, assetDays: assets };
    },

    async backup() {
      const stamp = new Date(now()).toISOString().slice(0, 10);
      const path = join(config.backupDir, `bots-${stamp}.sqlite`);
      await mkdir(config.backupDir, { recursive: true });
      await db.backup(path);
      const files = (await readdir(config.backupDir)).filter((f) => f.endsWith('.sqlite')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) {
        await rm(join(config.backupDir, old), { force: true });
      }
      return path;
    },
  };
}
