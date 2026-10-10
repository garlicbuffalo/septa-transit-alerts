// The server's main loop, one job per concern:
//
//   observe      every minute: poll TransitView (buses, trolleys, M1) and
//                TrainView (Regional Rail), record every position
//   collect      every 2 minutes: run the collector on the latest positions,
//                post to Bluesky from its beforePublish hook (the insights
//                account's reposts, rough hours, and digests too), link the
//                posts into the data, and publish the data branch
//   sample       every 15 seconds while a timelapse is recording: poll the
//                routes it follows (or the whole feed, for a snapshot)
//   render       every 30 seconds: render a finished timelapse and post it
//   snapshot     5 times a day: start the bus and Metro system snapshots
//   recaps       Sundays and the 1st: bunching hotspots and gaps (bus,
//                metro), the Regional Rail on-time recap
//   hall of fame Sundays: each mode account's best and worst five routes of
//                the week (average speed; Regional Rail by on-time share)
//   speed maps   every 2 hours by day: one route's speeds per account
//   speed rollup every 10 minutes: fold new positions into the per-day speed
//                tallies; the past week's speeds are published hourly with the
//                data, for the site's route and line pages
//   housekeeping hourly: prune old observations and dry-run assets
//   backup       nightly: a consistent copy of the database
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { collect } from '../../collector/collect.js';
import { loadArchive } from '../../collector/lib/archive.js';
import { createSources } from '../../collector/lib/sources.js';
import { screenVehicles } from '../../collector/lib/vehicleScreen.js';
import { normalizeTransitView } from '../../collector/lib/vehicles.js';
import { linkAlertPosts, postAlerts } from '../features/alerts.js';
import { maybePostCancellationRoundups } from '../features/cancellations.js';
import { postCrossBunching } from '../features/crossBunching.js';
import { linkDetectionPosts, postDetections } from '../features/detections.js';
import { maybePostGhostRollups } from '../features/ghosts.js';
import { postHallOfFame } from '../features/halloffame.js';
import {
  maybePostDigests,
  maybePostRoughHour,
  postDigest,
  repostHighlights,
} from '../features/insights.js';
import { maybePostRailRollup, postRailRecap, recordTrains } from '../features/rail.js';
import { postRecap } from '../features/recaps.js';
import { maybePublishSpeeds, rollupSpeeds } from '../features/speedhistory.js';
import { postSpeedMap } from '../features/speedmaps.js';
import {
  renderDueCapture,
  sampleCaptures,
  startDetectionCapture,
  startSnapshots,
  VIDEO_LIMITS,
} from '../features/timelapse.js';
import { renderAlertMap } from '../map/lineMap.js';
import { ffmpegAvailable } from '../video/encode.js';
import { pruneDb } from './db.js';
import { recordObservations } from './observations.js';
import { ensureRouteShapes, shapesFileStamp } from './shapes.js';

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
  // When the shapes were last read from the cache file, to read them again once the collector
  // has rebuilt it (a day's GTFS update, or a release that changes what the cache holds).
  let shapesStamp = null;
  // The last position kept for each vehicle (see screenVehicles), for observe().
  let screenState = {};
  // Timelapses need ffmpeg; checkVideo() confirms it's there.
  let videoReady = false;
  const limits = { ...VIDEO_LIMITS, dailyPerAccount: config.videoDailyCap };
  const timelapse = () =>
    videoReady ? (opts) => startDetectionCapture(db, opts, { limits }) : null;

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

  async function loadShapes() {
    shapes = await ensureRouteShapes({
      cacheDir: config.cacheDir,
      fixturesDir: config.fixturesDir,
      log,
    });
    shapesStamp = await shapesFileStamp(config);
    return shapes;
  }

  async function refreshShapes() {
    const stamp = await shapesFileStamp(config);
    if (stamp != null && stamp !== shapesStamp) await loadShapes();
    return shapes;
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
    loadShapes,

    /** Read the shapes again if the collector has rebuilt the cache since they were loaded. */
    refreshShapes,

    /** Turn timelapses on if they're enabled and ffmpeg runs. */
    async checkVideo() {
      videoReady = config.videos && (await ffmpegAvailable(config.ffmpegPath));
      return videoReady;
    },

    /** Poll positions for running timelapse captures (every 15 seconds). */
    sampleCaptures() {
      return sampleCaptures({ db, sources, shapes, now: now(), log });
    },

    /** Render and post the next finished timelapse, if any. */
    renderCaptures() {
      if (!videoReady) return null;
      return renderDueCapture({
        db,
        poster,
        shapes,
        basemap,
        now: now(),
        ffmpeg: config.ffmpegPath,
        limits,
        log,
      });
    },

    /** Start the bus and Metro system snapshots. */
    startSnapshots(opts = {}) {
      if (!videoReady) return [];
      return startSnapshots(db, { now: now(), hasAccount: poster.client.hasAccount, ...opts });
    },

    /** Post the bus or metro account's weekly or monthly recap. */
    recap(account, period) {
      return postRecap({ db, poster, basemap, account, period, now: now(), log });
    },

    /** Post an account's weekly Hall of Fame and Wall of Shame thread. */
    hallOfFame(account) {
      return postHallOfFame({ db, poster, account, now: now(), log });
    },

    /** Map and post one route's past-hour speeds for an account. */
    speedMap(account) {
      return postSpeedMap({ db, poster, shapes, basemap, account, now: now(), log });
    },

    /** Fold the positions since the last run into the per-day speed tallies. */
    speedRollup() {
      return rollupSpeeds(db, { shapes, now: now() });
    },

    /** Post the weekly or monthly Regional Rail recap. */
    railRecap(period) {
      return postRailRecap({ db, poster, now: now(), period, log });
    },

    /** Post the insights account's daily or weekly digest from the data directory. */
    async digest(period) {
      const { incidents, outages, dataStartTs } = await loadArchive(config.dataDir);
      return postDigest({ period, incidents, outages, db, poster, now: now(), dataStartTs, log });
    },

    async observe() {
      const t = now();
      const [tv, rr] = await Promise.allSettled([sources.transitView(), sources.trainView()]);
      let vehicles = [];
      if (tv.status === 'fulfilled') {
        latest.transitView = { ts: t, payload: tv.value };
        // Positions that can't be right stay out of the observations, so they can't skew the
        // speed maps or the timelapses, and neither can a trolley's repeated last fix from inside
        // the tunnel (it would read as a stop at the portal).
        const screened = screenVehicles(normalizeTransitView(tv.value, t).vehicles, {
          shapes,
          prev: screenState,
          now: t,
        });
        screenState = screened.state;
        vehicles = screened.vehicles.filter((v) => !v.frozen);
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
      recordTrains(db, t, trains);
      return { vehicles: vehicles.length, trains: trains.length, rows };
    },

    async collectTick() {
      await step('shapes', refreshShapes);
      const t = now();
      const maxAge = config.intervals.observeMs * 1.5;
      const fresh = (x) => (x && t - x.ts <= maxAge ? x.payload : null);
      const { ok, summary } = await collect({
        dataDir: config.dataDir,
        cacheDir: config.cacheDir,
        fixturesDir: config.fixturesDir,
        now: t,
        log: () => {},
        warn: log,
        sources: {
          transitView: async () => fresh(latest.transitView) ?? sources.transitView(),
          trainView: async () => fresh(latest.trainView) ?? sources.trainView(),
        },
        beforePublish: async ({
          incidents,
          outages,
          schedule,
          now: tickNow,
          vehicles: vehicleList,
          summary: { dataStartTs },
        }) => {
          // The positions the detectors used, screened the same way, so a post's map shows the
          // vehicles where the detection saw them.
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
              timelapse: timelapse(),
              now: tickNow,
              maxAgeMs: config.postMaxAgeMs,
              log,
            }),
          );
          const ghosts = await step('ghosts', () =>
            maybePostGhostRollups({ incidents, poster, db, now: tickNow, log }),
          );
          const rail = await step('rail', () =>
            maybePostRailRollup({ incidents, poster, db, now: tickNow, log }),
          );
          const cancellations = await step('cancellations', () =>
            maybePostCancellationRoundups({ incidents, poster, db, now: tickNow, log }),
          );
          const crossRoute = await step('cross-bunching', () =>
            postCrossBunching({
              vehicles: vehicleList,
              schedule,
              db,
              poster,
              shapes,
              basemap,
              timelapse: timelapse(),
              now: tickNow,
              log,
            }),
          );
          const reposts = await step('reposts', () =>
            repostHighlights({ db, poster, now: tickNow, log }),
          );
          const roughHour = await step('rough-hour', () =>
            maybePostRoughHour({ incidents, db, poster, now: tickNow, dataStartTs, log }),
          );
          const digests = await step('digests', () =>
            maybePostDigests({ incidents, outages, db, poster, now: tickNow, dataStartTs, log }),
          );
          const linked = linkAlertPosts(incidents, poster) + linkDetectionPosts(incidents, poster);
          return {
            alerts,
            detections,
            ghosts,
            rail,
            cancellations,
            crossRoute,
            reposts,
            roughHour,
            digests,
            linked,
          };
        },
      });
      let published = null;
      if (ok) {
        // The week's speeds ride along with the data (hourly, and with the
        // bot's other files, never on their own).
        await step('speed-files', () =>
          maybePublishSpeeds(db, { dataDir: config.dataDir, shapes, now: t }),
        );
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
          (summary.hook?.rail?.posts ? `, rail roundup ${summary.hook.rail.trains} trains` : '') +
          (summary.hook?.cancellations?.posts
            ? `, cancelled-trip roundup ${summary.hook.cancellations.routes} routes`
            : '') +
          (summary.hook?.crossRoute?.posted ? ', cross-route cluster posted' : '') +
          (summary.hook?.reposts?.reposted ? `, reposted ${summary.hook.reposts.reposted}` : '') +
          (summary.hook?.roughHour?.posted ? ', rough hour posted' : '') +
          Object.entries(summary.hook?.digests ?? {})
            .filter(([, r]) => r?.posted)
            .map(([period]) => `, ${period} digest posted`)
            .join('') +
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
