// The published data directory doubles as the collector's state. Monthly
// shards (alerts/<YYYY-MM>.json) are the source of truth for incidents —
// every incident lives in the shard of its first-seen Philadelphia month — and
// accessibility.json holds the outage archive. Each run loads them, applies
// source updates in memory, then regenerates every derived file:
//
//   alerts-recent.json            active + last RECENT_DAYS days
//   alerts-index.json             manifest: months, lines, id → month
//   incidents/by-line/<key>.json  all-time history per line/route
//   aggregates.json               year-over-year counts (overall + per mode)
//   daily-counts.json             per-day counts for the calendar page
//   accessibility.json            elevator outage archive
//
// Writes are skipped when a file's bytes are unchanged, so a quiet run only
// touches the few files that carry `generated_at`.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { easternDateKey, easternMonthKey } from './time.js';

export const SCHEMA_VERSION = 2;
export const RECENT_DAYS = 93;
const DAY_MS = 24 * 60 * 60 * 1000;
const YOY_WINDOW_DAYS = 30;
const DAILY_COUNT_DAYS = 400;
const ACCESSIBILITY_WINDOW_DAYS = 180;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path}: ${err.message}`);
  }
}

/**
 * Load the archive from a data directory (missing files = empty archive).
 * @param {string} dir
 */
export async function loadArchive(dir) {
  const index = await readJson(join(dir, 'alerts-index.json'));
  const incidents = new Map();
  let shardKeys = (index?.months ?? []).map((m) => m.key);
  if (shardKeys.length === 0) {
    // No index (first run, or a hand-assembled directory): read whatever shards exist.
    try {
      shardKeys = (await readdir(join(dir, 'alerts')))
        .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
        .map((f) => f.slice(0, 7));
    } catch {
      shardKeys = [];
    }
  }
  for (const key of shardKeys) {
    const shard = await readJson(join(dir, 'alerts', `${key}.json`));
    for (const inc of shard?.incidents ?? []) incidents.set(inc.id, inc);
  }
  // Belt-and-braces: an active incident must never be lost because a shard
  // write failed mid-run; the recent slice carries every active incident.
  const recent = await readJson(join(dir, 'alerts-recent.json'));
  for (const inc of recent?.incidents ?? []) if (!incidents.has(inc.id)) incidents.set(inc.id, inc);

  const accessibility = await readJson(join(dir, 'accessibility.json'));
  const outages = new Map((accessibility?.outages ?? []).map((o) => [o.id, o]));
  return {
    incidents,
    outages,
    dataStartTs: index?.data_start_ts ?? recent?.data_start_ts ?? null,
    shardKeys,
  };
}

function byFirstSeenDesc(a, b) {
  return (
    (b.lifecycle?.first_seen_ts ?? 0) - (a.lifecycle?.first_seen_ts ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** Network bucket for aggregates/counts: 'metro' | 'bus' | 'rail'. */
export function modeBucket(inc) {
  return inc.mode === 'regional_rail' ? 'rail' : inc.mode;
}

function yoyBucket(incidents, now, dataStartTs) {
  const windowMs = YOY_WINDOW_DAYS * DAY_MS;
  const currentEndTs = now;
  const currentStartTs = now - windowMs;
  const priorEndTs = now - 365 * DAY_MS;
  const priorStartTs = priorEndTs - windowMs;
  const enoughData = dataStartTs == null || dataStartTs <= priorStartTs;
  let currentCount = 0;
  let priorCount = 0;
  for (const inc of incidents) {
    const ts = inc.lifecycle?.first_seen_ts;
    if (ts == null) continue;
    if (ts >= currentStartTs && ts <= currentEndTs) currentCount += 1;
    else if (ts >= priorStartTs && ts <= priorEndTs) priorCount += 1;
  }
  return {
    enoughData,
    currentCount,
    priorCount,
    pctChange: enoughData && priorCount > 0 ? (currentCount - priorCount) / priorCount : null,
    currentStartTs,
    currentEndTs,
    priorStartTs,
    priorEndTs,
  };
}

/** Year-over-year aggregates payload. */
export function buildAggregates(all, now, dataStartTs) {
  const byMode = { metro: [], bus: [], rail: [] };
  for (const inc of all) byMode[modeBucket(inc)]?.push(inc);
  return {
    schema_version: 1,
    generated_at: now,
    data_start_ts: dataStartTs,
    yoy: {
      window_days: YOY_WINDOW_DAYS,
      overall: yoyBucket(all, now, dataStartTs),
      by_mode: {
        metro: yoyBucket(byMode.metro, now, dataStartTs),
        bus: yoyBucket(byMode.bus, now, dataStartTs),
        rail: yoyBucket(byMode.rail, now, dataStartTs),
      },
    },
  };
}

/** Per-day incident counts (by first-seen Philadelphia day) for the calendar. */
export function buildDailyCounts(all, now, dataStartTs) {
  const cutoff = now - DAILY_COUNT_DAYS * DAY_MS;
  const days = new Map();
  for (const inc of all) {
    const ts = inc.lifecycle?.first_seen_ts;
    if (ts == null || ts < cutoff || ts > now) continue;
    const date = easternDateKey(ts);
    if (!days.has(date)) {
      days.set(date, {
        date,
        metro_count: 0,
        bus_count: 0,
        rail_count: 0,
        by_line: {},
        by_route: {},
        by_rail_line: {},
      });
    }
    const d = days.get(date);
    const bucket = modeBucket(inc);
    const field = bucket === 'metro' ? 'by_line' : bucket === 'bus' ? 'by_route' : 'by_rail_line';
    d[`${bucket}_count`] += 1;
    for (const r of inc.routes || []) d[field][r] = (d[field][r] ?? 0) + 1;
  }
  return {
    schema_version: 1,
    generated_at: now,
    data_start_ts: dataStartTs,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Write the whole archive back out. Returns the list of files written.
 * @param {string} dir
 * @param {{ incidents: Map<string, object>, outages: Map<string, object>, dataStartTs: number, now: number, previousShardKeys?: string[] }} state
 */
export async function publishArchive(
  dir,
  { incidents, outages, dataStartTs, now, previousShardKeys = [] },
) {
  const written = [];
  const put = async (rel, data) => {
    const path = join(dir, rel);
    const body = `${JSON.stringify(data)}\n`;
    let current = null;
    try {
      current = await readFile(path, 'utf8');
    } catch {
      current = null;
    }
    if (current === body) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    written.push(rel);
  };

  const all = [...incidents.values()].sort(byFirstSeenDesc);

  // Monthly shards.
  const byMonth = new Map();
  for (const inc of all) {
    const key = easternMonthKey(inc.lifecycle?.first_seen_ts ?? now);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(inc);
  }
  for (const [key, list] of byMonth) {
    await put(`alerts/${key}.json`, {
      schema_version: SCHEMA_VERSION,
      month: key,
      incidents: list,
    });
  }
  for (const key of previousShardKeys) {
    if (!byMonth.has(key)) {
      await rm(join(dir, 'alerts', `${key}.json`), { force: true });
      written.push(`alerts/${key}.json (removed)`);
    }
  }

  // Recent slice.
  const recentFromTs = now - RECENT_DAYS * DAY_MS;
  const recent = all.filter(
    (inc) => inc.lifecycle?.active || (inc.lifecycle?.first_seen_ts ?? 0) >= recentFromTs,
  );
  await put('alerts-recent.json', {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    data_start_ts: dataStartTs,
    recent_from_ts: recentFromTs,
    incidents: recent,
  });

  // Per-line all-time files.
  const byLine = new Map();
  for (const inc of all) {
    for (const r of inc.routes || []) {
      if (!byLine.has(r)) byLine.set(r, { mode: inc.mode, incidents: [] });
      byLine.get(r).incidents.push(inc);
    }
  }
  for (const [key, { incidents: list }] of byLine) {
    await put(`incidents/by-line/${encodeURIComponent(key)}.json`, {
      schema_version: SCHEMA_VERSION,
      line: key,
      incidents: list,
    });
  }

  // Index.
  const months = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => {
      const ts = list.map((i) => i.lifecycle?.first_seen_ts ?? now);
      return {
        key,
        url: `alerts/${key}.json`,
        count: list.length,
        min_ts: Math.min(...ts),
        max_ts: Math.max(...ts),
      };
    });
  const lines = [...byLine.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, { mode, incidents: list }]) => ({
      key,
      mode,
      url: `incidents/by-line/${encodeURIComponent(key)}.json`,
      count: list.length,
    }));
  const idMonth = {};
  for (const [key, list] of byMonth) for (const inc of list) idMonth[inc.id] = key;
  await put('alerts-index.json', {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    data_start_ts: dataStartTs,
    recent_from_ts: recentFromTs,
    months,
    lines,
    id_month: idMonth,
    rkey_month: {},
  });

  await put('aggregates.json', buildAggregates(all, now, dataStartTs));
  await put('daily-counts.json', buildDailyCounts(all, now, dataStartTs));

  const outageList = [...outages.values()].sort(
    (a, b) =>
      Number(b.lifecycle?.active) - Number(a.lifecycle?.active) ||
      (b.lifecycle?.first_seen_ts ?? 0) - (a.lifecycle?.first_seen_ts ?? 0) ||
      a.id.localeCompare(b.id),
  );
  await put('accessibility.json', {
    schema_version: 1,
    generated_at: now,
    data_start_ts: dataStartTs,
    window_days: ACCESSIBILITY_WINDOW_DAYS,
    outages: outageList,
  });

  return written;
}
