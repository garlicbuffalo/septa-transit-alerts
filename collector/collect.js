#!/usr/bin/env node
// SEPTA data collector — one polling tick. Fetches SEPTA's alerts, TrainView,
// and elevator feeds, folds them into the archive in --data-dir, and rewrites
// the published files the site reads. Designed to run every ~10 minutes (the
// collect.yml GitHub Actions workflow), but any scheduler works. Prints a JSON
// summary to stdout; `changed` counts rider-visible changes (see fingerprints).
//
//   node collector/collect.js --data-dir data
//   node collector/collect.js --data-dir /tmp/d --fixtures collector/test/fixtures --now 1791300000000
//
// Exit code is non-zero only when every source failed, so a single flaky
// endpoint doesn't fail the run (its changes are simply skipped this tick).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadArchive, publishArchive } from './lib/archive.js';
import { applyElevators } from './lib/elevators.js';
import { applyOfficialAlerts } from './lib/officialAlerts.js';
import { advanceCancellations, applyTrainView } from './lib/railTrains.js';
import { createSources } from './lib/sources.js';

// A rider-visible fingerprint of each record: an incident opening, resolving,
// or getting new SEPTA text, or an elevator outage starting or ending. Updates
// that only refresh a timestamp or a running delay figure don't count, so the
// deploy workflow can redeploy on real changes and leave the rest to its
// periodic catch-up run.
function fingerprints(incidents, outages) {
  const out = new Map();
  for (const inc of incidents.values()) {
    const alert = inc.official_alert;
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

export async function collect({
  dataDir,
  fixturesDir = null,
  now = Date.now(),
  log = console.log,
}) {
  const sources = createSources({ fixturesDir });
  const archive = await loadArchive(dataDir);
  const before = fingerprints(archive.incidents, archive.outages);
  const dataStartTs = archive.dataStartTs ?? now;
  const summary = { now, dataStartTs, sources: {} };

  const [alerts, trainView, elevators] = await Promise.allSettled([
    sources.alerts(),
    sources.trainView(),
    sources.elevators(),
  ]);

  if (alerts.status === 'fulfilled') {
    summary.sources.alerts = applyOfficialAlerts(archive.incidents, alerts.value, now).stats;
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

  const ok = Object.values(summary.sources).some((s) => !s.error);
  if (ok) {
    summary.written = await publishArchive(dataDir, {
      incidents: archive.incidents,
      outages: archive.outages,
      dataStartTs,
      now,
      previousShardKeys: archive.shardKeys,
    });
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
      fixtures: { type: 'string' },
      now: { type: 'string' },
    },
  });
  const { ok } = await collect({
    dataDir: resolve(values['data-dir']),
    fixturesDir: values.fixtures ? resolve(values.fixtures) : null,
    now: values.now ? Number(values.now) : Date.now(),
  });
  process.exit(ok ? 0 : 1);
}
