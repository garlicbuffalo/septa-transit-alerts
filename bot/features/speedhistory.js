// A week of speeds for the site's route and line pages (bus routes, trolleys,
// the M1, and Regional Rail lines). The observations are kept only a few days, so the rollup folds
// them into per-day tallies as they arrive: for each stretch of a route's
// shape, how far its vehicles went and how long it took, per Philadelphia
// day. The site's maps are the past seven days' tallies added together (total
// distance over total time, as the posted speed maps do), published as one
// JSON file per route under speeds/ in the data directory (Regional Rail
// lines under speeds/rail/, so a line's key can't clash with a bus route's).
//
// A bus, trolley, or M1 route has a shape for each direction, told apart by
// the direction SEPTA reports. TrainView reports none, so a Regional Rail line
// is one map of both directions along its main alignment (the longest of its
// bundled shapes), in half-mile stretches.
//
// Each observation pair is counted once: a run takes the observations since
// the last run (plus a few minutes before them, for each vehicle's previous
// report) and keeps the pairs whose later report is new.

import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simplify } from '../../collector/lib/shapes.js';
import { easternDateKey } from '../../collector/lib/time.js';
import { METRO_LINES } from '../../src/lib/metroLines.js';
import railShapes from '../../src/lib/railLineShapes.json' with { type: 'json' };
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { getMeta, setMeta } from '../lib/db.js';
import { locateAlong, measureShape } from '../lib/geo.js';
import { inService, MPH_PER_MPS, SPEED_CONFIG, speedPairs } from './speedmaps.js';

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const HISTORY = {
  days: 7,
  // A run works through the observations in slices this long, so a first run
  // over days of them doesn't hold the server up.
  sliceMs: 30 * MIN_MS,
  // Far enough back to find each vehicle's previous report (SPEED_CONFIG.maxDtMs).
  lookbackMs: 4 * MIN_MS,
  // Shapes are simplified to this before they're measured and drawn: it's
  // finer than the maps can show and keeps the files small and the rollup quick.
  simplifyM: 20,
  stretchM: 400,
  minStretches: 20,
  maxStretches: 80,
  // A stretch needs this many readings to be shown at all.
  minReadings: 3,
  // A direction with data for under this share of its route isn't published.
  minCoverage: 0.2,
  // Direction shapes whose length differs by more than this are a new shape.
  lengthTolerance: 0.02,
  publishEveryMs: 60 * MIN_MS,
  dir: 'speeds',
  version: 1,
};
const MODES = {
  bus: SPEED_CONFIG.bus,
  metro: SPEED_CONFIG.metro,
  regional_rail: SPEED_CONFIG.rail,
};
const RAIL = 'regional_rail';
// What a Regional Rail line's one direction is called.
const RAIL_TEXT = 'Both directions';
const SAMPLE_POINTS = 100;
const ROLLUP_KEY = 'speed_rollup_ts';
const PUBLISHED_KEY = 'speed_published_ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

// The measured, simplified directions of each route, built once per shapes load.
const preparedByShapes = new WeakMap();
const preparedRail = new Map();
function prepare(directions) {
  return directions
    .filter(([, points]) => points?.length >= 2)
    .map(([id, points]) => ({ id, measured: measureShape(simplifyShape(points)) }));
}
function directionsOf(shapes, mode, route) {
  if (mode === RAIL) {
    if (!preparedRail.has(route)) {
      const [main] = (railShapes[route] ?? [])
        .map((points) => prepare([['0', points]])[0])
        .filter(Boolean)
        .sort((a, b) => b.measured.length - a.measured.length);
      preparedRail.set(route, main ? [main] : []);
    }
    return preparedRail.get(route);
  }
  if (!shapes) return [];
  if (!preparedByShapes.has(shapes)) preparedByShapes.set(shapes, new Map());
  const cache = preparedByShapes.get(shapes);
  if (!cache.has(route)) cache.set(route, prepare(shapes.directions(route)));
  return cache.get(route);
}

// Simplified to what the maps can show, at the 5 decimals (about a meter) the
// files keep.
const simplifyShape = (points) =>
  simplify(points, HISTORY.simplifyM).map(([lat, lon]) => [round(lat, 5), round(lon, 5)]);

const sameLength = (a, b) => Math.abs(a - b) <= HISTORY.lengthTolerance * Math.max(a, b);

/** How many stretches a route of this length is cut into, and how long each is. */
export function stretchesFor(length) {
  const count = Math.max(
    HISTORY.minStretches,
    Math.min(HISTORY.maxStretches, Math.round(length / HISTORY.stretchM)),
  );
  return { count, binM: length / count };
}

// Meters from the sample points to a shape, summed (for telling which of a
// route's shapes a direction follows).
function distanceScore(measured, points) {
  let total = 0;
  for (const p of points) total += locateAlong(measured, p).off;
  return total;
}

function evenly(rows, n) {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

/**
 * Which of a route's shapes each direction text follows: the nearest, except
 * that two directions don't share a shape while another is free (an
 * out-and-back route's two shapes can lie along the same streets).
 * @param {Map<string, object[]>} samplesByText
 * @param {Array<{ id: string, measured: object }>} directions
 * @param {Set<string>} taken shape ids other directions already follow
 * @returns {Map<string, string>} text → shape id
 */
export function assignDirections(samplesByText, directions, taken = new Set()) {
  const scores = new Map();
  for (const [text, rows] of samplesByText) {
    const points = evenly(rows, SAMPLE_POINTS);
    scores.set(
      text,
      directions.map((d) => ({ id: d.id, score: distanceScore(d.measured, points) })),
    );
  }
  const out = new Map();
  const texts = [...samplesByText.keys()];
  const free = directions.filter((d) => !taken.has(d.id));
  if (texts.length === 2 && free.length >= 2) {
    // The pairing of two texts to two shapes with the least distance in all.
    let best = null;
    for (const a of free) {
      for (const b of free) {
        if (a.id === b.id) continue;
        const total =
          scores.get(texts[0]).find((s) => s.id === a.id).score +
          scores.get(texts[1]).find((s) => s.id === b.id).score;
        if (!best || total < best.total) best = { total, ids: [a.id, b.id] };
      }
    }
    texts.forEach((t, i) => {
      out.set(t, best.ids[i]);
    });
    return out;
  }
  const claimed = new Set(taken);
  for (const text of texts) {
    const ranked = [...scores.get(text)].sort((a, b) => a.score - b.score);
    const pick = ranked.find((s) => !claimed.has(s.id)) ?? ranked[0];
    out.set(text, pick.id);
    claimed.add(pick.id);
  }
  return out;
}

// Directions known for a route, from speed_dirs: text → { dir, len, bin_m }.
function knownDirections(db, mode, route) {
  return new Map(
    db
      .prepare('SELECT text, dir, len, bin_m FROM speed_dirs WHERE mode = ? AND route = ?')
      .all(mode, route)
      .map((r) => [r.text, r]),
  );
}

function resolveDirections(db, mode, route, byText, directions, ts) {
  const known = knownDirections(db, mode, route);
  const byId = new Map(directions.map((d) => [d.id, d]));
  const resolved = new Map(); // text → { dir, measured, binM }
  const unknown = new Map();
  for (const [text, rows] of byText) {
    const k = known.get(text);
    const shape = k && byId.get(k.dir);
    if (shape && sameLength(k.len, shape.measured.length)) {
      resolved.set(text, { dir: k.dir, measured: shape.measured, binM: k.bin_m });
    } else {
      unknown.set(text, rows);
    }
  }
  if (unknown.size) {
    const taken = new Set([...resolved.values()].map((r) => r.dir));
    for (const [text, dir] of assignDirections(unknown, directions, taken)) {
      const { measured } = byId.get(dir);
      const binM = mode === RAIL ? MODES[mode].binM : stretchesFor(measured.length).binM;
      // A shape that changed length starts its tallies over.
      db.prepare('DELETE FROM speed_bins WHERE mode = ? AND route = ? AND dir = ?').run(
        mode,
        route,
        dir,
      );
      db.prepare(
        'INSERT OR REPLACE INTO speed_dirs (mode, route, text, dir, len, bin_m, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(mode, route, text, dir, measured.length, binM, ts);
      resolved.set(text, { dir, measured, binM });
    }
  }
  return resolved;
}

/** One slice of observations: the tallies it adds, keyed day|mode|route|dir|bin. */
function tallySlice(db, shapes, from, to) {
  const rows = db
    .prepare(
      `SELECT ts, mode, route, vehicle_id, direction, lat, lon, report_ts FROM observations
       WHERE ts > ? AND ts <= ? AND mode IN ('bus', 'metro', 'regional_rail')`,
    )
    .all(from - HISTORY.lookbackMs, to);
  const byRoute = new Map();
  for (const r of rows) {
    if (r.mode === RAIL) {
      if (!RAIL_LINES[r.route]) continue;
    } else if (!r.direction || (r.mode === 'metro' && !METRO_LINES[r.route])) continue;
    const key = `${r.mode}|${r.route}`;
    if (!byRoute.has(key)) byRoute.set(key, { mode: r.mode, route: r.route, rows: [] });
    byRoute.get(key).rows.push(r);
  }
  const tallies = new Map();
  for (const { mode, route, rows: routeRows } of byRoute.values()) {
    const directions = directionsOf(shapes, mode, route);
    if (!directions.length) continue;
    const byText = new Map();
    const seen = new Set();
    for (const r of routeRows) {
      const t = r.report_ts ?? r.ts;
      // A report seen again by the next poll is still the one report.
      const id = `${r.vehicle_id}|${t}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const text = mode === RAIL ? RAIL_TEXT : r.direction;
      if (!byText.has(text)) byText.set(text, []);
      byText.get(text).push({
        vehicle_id: r.vehicle_id,
        t,
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
      });
    }
    const resolved = resolveDirections(db, mode, route, byText, directions, to);
    const cfg = MODES[mode];
    for (const [text, samples] of byText) {
      const { dir, measured, binM } = resolved.get(text);
      const count = Math.ceil(measured.length / binM);
      for (const { b, along, dist, dt } of speedPairs(samples, measured, cfg)) {
        if (b.ts <= from) continue;
        const bin = Math.min(count - 1, Math.floor(along / binM));
        const key = `${easternDateKey(b.t)}|${mode}|${route}|${dir}|${bin}`;
        const t = tallies.get(key) ?? { dist: 0, dt: 0, n: 0 };
        t.dist += dist;
        t.dt += dt;
        t.n++;
        tallies.set(key, t);
      }
    }
  }
  return tallies;
}

/**
 * Fold the observations since the last run into the per-day tallies. The
 * first run goes back to the oldest observation kept.
 * @param {import('better-sqlite3').Database} db
 * @param {{ shapes: object | null, now: number }} opts shapes are the bus and Metro
 *   route shapes; without them only Regional Rail is rolled up
 */
export async function rollupSpeeds(db, { shapes, now }) {
  let from = Number(getMeta(db, ROLLUP_KEY));
  if (!Number.isFinite(from) || from <= 0) {
    from = db.prepare('SELECT MIN(ts) AS ts FROM observations').get().ts ?? now;
    from -= 1;
  }
  const upsert = db.prepare(
    `INSERT INTO speed_bins (day, mode, route, dir, bin, dist, dt, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, mode, route, dir, bin) DO UPDATE SET
       dist = dist + excluded.dist, dt = dt + excluded.dt, n = n + excluded.n`,
  );
  let pairs = 0;
  while (from < now) {
    const to = Math.min(now, from + HISTORY.sliceMs);
    db.transaction(() => {
      const tallies = tallySlice(db, shapes, from, to);
      for (const [key, t] of tallies) {
        const [day, mode, route, dir, bin] = key.split('|');
        upsert.run(day, mode, route, dir, Number(bin), t.dist, t.dt, t.n);
        pairs += t.n;
      }
      setMeta(db, ROLLUP_KEY, to);
    })();
    from = to;
    await tick();
  }
  return { pairs };
}

// SEPTA writes "NorthBound"; riders read "Northbound".
const directionLabel = (text) => text[0].toUpperCase() + text.slice(1).toLowerCase();

/**
 * The week's speeds for each route, as the files the site reads.
 * @returns {Map<string, object>} `${mode}|${route}` → file contents
 */
export function buildSpeedFiles(db, { shapes, now }) {
  const days = Array.from({ length: HISTORY.days }, (_, i) =>
    easternDateKey(now - i * DAY_MS),
  ).reverse();
  const rows = db
    .prepare(
      `SELECT mode, route, dir, bin, SUM(dist) AS dist, SUM(dt) AS dt, SUM(n) AS n,
              COUNT(DISTINCT day) AS days
       FROM speed_bins WHERE day >= ? AND day <= ? GROUP BY mode, route, dir, bin`,
    )
    .all(days[0], days.at(-1));
  const dayRows = db
    .prepare(
      `SELECT mode, route, COUNT(DISTINCT day) AS days FROM speed_bins
       WHERE day >= ? AND day <= ? GROUP BY mode, route`,
    )
    .all(days[0], days.at(-1));
  const daysByRoute = new Map(dayRows.map((r) => [`${r.mode}|${r.route}`, r.days]));
  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.mode}|${r.route}|${r.dir}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const files = new Map();
  for (const [key, bins] of grouped) {
    const [mode, route, dir] = key.split('|');
    const shape = directionsOf(shapes, mode, route).find((d) => d.id === dir);
    const texts = db
      .prepare(
        'SELECT text, len, bin_m FROM speed_dirs WHERE mode = ? AND route = ? AND dir = ? ORDER BY ts DESC',
      )
      .all(mode, route, dir);
    if (!shape || !texts.length || !sameLength(texts[0].len, shape.measured.length)) continue;
    const cfg = MODES[mode];
    const { len, bin_m: binM } = texts[0];
    const count = Math.ceil(len / binM);
    const mph = Array(count).fill(null);
    const n = Array(count).fill(0);
    let dist = 0;
    let dt = 0;
    let readings = 0;
    for (const b of bins) {
      if (b.bin >= count) continue;
      dist += b.dist;
      dt += b.dt;
      readings += b.n;
      n[b.bin] = b.n;
      if (b.n >= HISTORY.minReadings) mph[b.bin] = round((b.dist / (b.dt / 1000)) * MPH_PER_MPS, 1);
    }
    const eligible = mph.filter((_, i) => inService(i, binM, len, cfg)).length;
    const shown = mph.filter((v, i) => v != null && inService(i, binM, len, cfg)).length;
    const coverage = eligible ? shown / eligible : 0;
    if (coverage < HISTORY.minCoverage || !dt) continue;
    // Every direction text SEPTA uses for this shape is one label, the latest first.
    const direction = {
      id: dir,
      label: directionLabel(texts[0].text),
      avg_mph: round((dist / (dt / 1000)) * MPH_PER_MPS, 1),
      coverage: round(coverage, 2),
      readings,
      bin_m: round(binM, 1),
      mph,
      n,
      shape: shape.measured.points,
    };
    const fileKey = `${mode}|${route}`;
    if (!files.has(fileKey)) {
      files.set(fileKey, {
        schema_version: HISTORY.version,
        mode,
        route,
        generated_at: now,
        window_days: HISTORY.days,
        from_day: days[0],
        to_day: days.at(-1),
        days_with_data: daysByRoute.get(fileKey) ?? 0,
        directions: [],
      });
    }
    files.get(fileKey).directions.push(direction);
  }
  for (const file of files.values()) file.directions.sort((a, b) => a.id.localeCompare(b.id));
  return files;
}

/**
 * Write the speed files into the data directory (replacing the ones for routes
 * with no data this week). Returns how many were written.
 */
export async function publishSpeeds(db, { dataDir, shapes, now }) {
  const files = buildSpeedFiles(db, { shapes, now });
  const written = new Map(); // directory → file names
  for (const file of files.values()) {
    const sub = file.mode === RAIL ? join(HISTORY.dir, 'rail') : HISTORY.dir;
    const dir = join(dataDir, sub);
    await mkdir(dir, { recursive: true });
    const name = `${encodeURIComponent(file.route)}.json`;
    if (!written.has(dir)) written.set(dir, new Set());
    written.get(dir).add(name);
    const path = join(dir, name);
    await writeFile(`${path}.tmp`, `${JSON.stringify(file)}\n`);
    await rename(`${path}.tmp`, path);
  }
  for (const dir of [join(dataDir, HISTORY.dir), join(dataDir, HISTORY.dir, 'rail')]) {
    const names = written.get(dir) ?? new Set();
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && !names.has(entry.name))
        await rm(join(dir, entry.name), { force: true });
    }
  }
  setMeta(db, PUBLISHED_KEY, now);
  return { routes: files.size };
}

/** Publish the speed files when the last publish is over an hour old. */
export async function maybePublishSpeeds(db, { dataDir, shapes, now }) {
  const last = Number(getMeta(db, PUBLISHED_KEY) ?? 0);
  if (now - last < HISTORY.publishEveryMs) return { skipped: 'recent' };
  return publishSpeeds(db, { dataDir, shapes, now });
}
