#!/usr/bin/env node
// SEPTA data collector — one polling tick. Fetches SEPTA's alerts, TrainView,
// elevator, TransitView (vehicle positions), and GTFS-realtime trip feeds,
// folds them into the archive in --data-dir, and rewrites the published files
// the site reads. Designed to run every ~10 minutes (the collect.yml GitHub
// Actions workflow), but any scheduler works. Prints a JSON summary to stdout;
// `changed` counts rider-visible changes (see fingerprints). Diagnostics go to
// stderr.
//
//   node collector/collect.js --data-dir data [--cache-dir .collector-cache]
//   node collector/collect.js --data-dir /tmp/d --fixtures collector/test/fixtures --now 1791300000000
//
// --cache-dir holds the GTFS schedule index (rebuilt daily); the detectors'
// tick-to-tick state lives in the data directory (STATE_FILE), which is left
// out of the deployed site.
//
// Exit code is non-zero only when every source failed, so a single flaky
// endpoint doesn't fail the run (its changes are simply skipped this tick).
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadArchive, publishArchive } from './lib/archive.js';
import { applyElevators } from './lib/elevators.js';
import { decodeTripUpdates } from './lib/gtfsRealtime.js';
import { applyOfficialAlerts } from './lib/officialAlerts.js';
import { advanceCancellations, applyTrainView } from './lib/railTrains.js';
import { loadSchedule } from './lib/schedule.js';
import {
  loadRouteShapes,
  PUBLISHED_SHAPES_DIR,
  publishRouteShapes,
  publishSystemMap,
  SYSTEM_MAP_FILE,
} from './lib/shapes.js';
import { createSources } from './lib/sources.js';
import { advanceTripCancellations, applyTripCancellations } from './lib/tripCancellations.js';
import { applyVehicleConditions, findConditions, VEHICLE_SOURCES } from './lib/vehicleDetectors.js';
import { screenVehicles } from './lib/vehicleScreen.js';
import { normalizeTransitView } from './lib/vehicles.js';

export const STATE_FILE = '_collector-state.json';

async function loadState(dataDir) {
  try {
    const state = JSON.parse(await readFile(join(dataDir, STATE_FILE), 'utf8'));
    return state?.version === 1 ? state : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

// A rider-visible fingerprint of each record: an incident opening, resolving,
// or getting new SEPTA text, or an elevator outage starting or ending. Updates
// that only refresh a timestamp or a running delay figure don't count, so the
// deploy workflow can redeploy on real changes and leave the rest to its
// periodic catch-up run. Bot-only vehicle detections (gaps, bunching, …) come
// and go too often to redeploy for each; they ride the periodic deploys.
function fingerprints(incidents, outages) {
  const out = new Map();
  for (const inc of incidents.values()) {
    const alert = inc.official_alert;
    if (!alert && inc.detections?.every((d) => VEHICLE_SOURCES.has(d.source))) continue;
    out.set(
      `incident:${inc.id}`,
      [
        inc.lifecycle?.active,
        inc.lifecycle?.resolved_ts,
        alert?.headline,
        alert?.description,
        inc.status?.state,
      ].join('|'),
    );
  }
  for (const o of outages.values()) {
    out.set(`outage:${o.id}`, String(o.lifecycle?.active));
  }
  return out;
}

function countChanges(before, after) {
  let changed = 0;
  for (const [key, value] of after) if (before.get(key) !== value) changed++;
  for (const key of before.keys()) if (!after.has(key)) changed++;
  return changed;
}

/**
 * One collector tick.
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string | null} [opts.cacheDir]
 * @param {string | null} [opts.fixturesDir]
 * @param {number} [opts.now]
 * @param {Partial<ReturnType<typeof createSources>>} [opts.sources] replace
 *   individual source readers (the bot service passes its latest polled
 *   vehicle positions instead of fetching them again)
 * @param {(ctx: { incidents: Map<string, object>, outages: Map<string, object>,
 *   state: object, schedule: object | null, vehicles: object[], now: number, summary: object }) => Promise<object>} [opts.beforePublish]
 *   runs after every source is applied and before the files are written; the
 *   bot service posts to Bluesky here and links the posts into the incidents
 */
export async function collect({
  dataDir,
  cacheDir = null,
  fixturesDir = null,
  now = Date.now(),
  log = console.log,
  warn = console.error,
  sources: sourceOverrides = null,
  beforePublish = null,
}) {
  const sources = { ...createSources({ fixturesDir }), ...(sourceOverrides ?? {}) };
  const archive = await loadArchive(dataDir);
  const state = await loadState(dataDir);
  const before = fingerprints(archive.incidents, archive.outages);
  const dataStartTs = archive.dataStartTs ?? now;
  const summary = { now, dataStartTs, sources: {} };

  const [alerts, trainView, elevators, transitView, tripUpdates, schedule] =
    await Promise.allSettled([
      sources.alerts(),
      sources.trainView(),
      sources.elevators(),
      sources.transitView(),
      sources.tripUpdates(),
      loadSchedule({ cacheDir, fixturesDir, now, log: warn }),
    ]);
  const sched = schedule.status === 'fulfilled' ? schedule.value : null;

  if (alerts.status === 'fulfilled') {
    if (!state.alertMisses) state.alertMisses = {};
    summary.sources.alerts = applyOfficialAlerts(archive.incidents, alerts.value, now, {
      misses: state.alertMisses,
    }).stats;
  } else {
    summary.sources.alerts = { error: String(alerts.reason?.message ?? alerts.reason) };
  }

  if (trainView.status === 'fulfilled') {
    const { stats } = await applyTrainView(archive.incidents, trainView.value, now, {
      lookupSchedule: sources.railSchedule,
    });
    summary.sources.trainView = stats;
  } else {
    advanceCancellations(archive.incidents, now);
    summary.sources.trainView = { error: String(trainView.reason?.message ?? trainView.reason) };
  }

  if (elevators.status === 'fulfilled') {
    try {
      summary.sources.elevators = applyElevators(archive.outages, elevators.value, now).stats;
    } catch (err) {
      summary.sources.elevators = { error: err.message };
    }
  } else {
    summary.sources.elevators = { error: String(elevators.reason?.message ?? elevators.reason) };
  }

  // Bus and Metro trip cancellations (needs the schedule to place each trip).
  const cancelledTripIds = new Set();
  if (tripUpdates.status !== 'fulfilled') {
    summary.sources.tripUpdates = {
      error: String(tripUpdates.reason?.message ?? tripUpdates.reason),
    };
  } else if (!sched) {
    summary.sources.tripUpdates = { error: 'no GTFS schedule available' };
  } else {
    try {
      const feed = decodeTripUpdates(tripUpdates.value);
      if (feed.trips.length === 0) throw new Error('empty TripUpdates feed');
      for (const t of feed.trips) if (t.relationship === 'CANCELED') cancelledTripIds.add(t.tripId);
      summary.sources.tripUpdates = applyTripCancellations(
        archive.incidents,
        feed,
        sched,
        now,
      ).stats;
    } catch (err) {
      summary.sources.tripUpdates = { error: err.message };
    }
  }
  advanceTripCancellations(archive.incidents, now);

  // Vehicle-position detectors (gaps, bunching, missing vehicles, held).
  let vehicles = []; // the positions that passed the screen, for the detectors and beforePublish
  if (transitView.status !== 'fulfilled') {
    summary.sources.transitView = {
      error: String(transitView.reason?.message ?? transitView.reason),
    };
  } else if (!sched) {
    summary.sources.transitView = { error: 'no GTFS schedule available' };
  } else {
    try {
      const normalized = normalizeTransitView(transitView.value, now);
      // Positions that can't be right (a trolley 6 km from the tunnel it just entered) are left
      // out of everything below, so they can't open a detection or be drawn on its map.
      const screened = screenVehicles(normalized.vehicles, {
        shapes: await loadRouteShapes({ cacheDir, fixturesDir }),
        prev: state.screen,
        now,
      });
      state.screen = screened.state;
      vehicles = screened.vehicles;
      const { placeholders, stale } = normalized;
      const found = findConditions({ vehicles, schedule: sched, cancelledTripIds, state, now });
      // On a degraded tracker feed, leave detections as they are this tick.
      const applied = found.stats.feedHealthy
        ? applyVehicleConditions(archive.incidents, found.conditions, state, now)
        : { stats: { held: true } };
      summary.sources.transitView = {
        ...found.stats,
        placeholders,
        stale,
        dropped: screened.dropped,
        conditions: found.conditions.size,
        ...applied.stats,
      };
    } catch (err) {
      summary.sources.transitView = { error: err.message };
    }
  }

  const ok = Object.values(summary.sources).some((s) => !s.error);
  if (ok && beforePublish) {
    try {
      summary.hook = await beforePublish({
        incidents: archive.incidents,
        outages: archive.outages,
        state,
        schedule: sched,
        vehicles,
        now,
        summary,
      });
    } catch (err) {
      warn(`beforePublish: ${err.stack ?? err.message}`);
      summary.hook = { error: err.message };
    }
  }
  if (ok) {
    summary.written = await publishArchive(dataDir, {
      incidents: archive.incidents,
      outages: archive.outages,
      dataStartTs,
      now,
      previousShardKeys: archive.shardKeys,
    });
    // Bus route shapes for the site's route maps and system map, whenever the
    // GTFS cache has been rebuilt (or the files are missing).
    try {
      const shapes = await loadRouteShapes({ cacheDir, fixturesDir });
      const builtAt = shapes?.data.built_at ?? null;
      const published =
        existsSync(join(dataDir, PUBLISHED_SHAPES_DIR)) &&
        existsSync(join(dataDir, SYSTEM_MAP_FILE));
      if (shapes && (state.shapesBuiltAt !== builtAt || !published)) {
        summary.shapes = await publishRouteShapes(dataDir, shapes);
        summary.systemMap = await publishSystemMap(dataDir, shapes);
        state.shapesBuiltAt = builtAt;
      }
    } catch (err) {
      warn(`route shapes: ${err.message}`);
    }
    state.updated_at = now;
    await writeFile(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`);
  }
  summary.changed = ok ? countChanges(before, fingerprints(archive.incidents, archive.outages)) : 0;
  summary.incidents = archive.incidents.size;
  summary.active = [...archive.incidents.values()].filter((i) => i.lifecycle?.active).length;
  log(JSON.stringify(summary, null, 2));
  return { ok, summary };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'cache-dir': { type: 'string', default: '.collector-cache' },
      fixtures: { type: 'string' },
      now: { type: 'string' },
    },
  });
  const { ok } = await collect({
    dataDir: resolve(values['data-dir']),
    cacheDir: resolve(values['cache-dir']),
    fixturesDir: values.fixtures ? resolve(values.fixtures) : null,
    now: values.now ? Number(values.now) : Date.now(),
  });
  process.exit(ok ? 0 : 1);
}
