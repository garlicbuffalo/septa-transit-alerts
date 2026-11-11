// Slow zones: the stretches where SEPTA's buses and trolleys crawl.
//
// From the speed tallies behind the site's speed maps (features/speedhistory.js):
// each direction of each route is cut into stretches of about a quarter mile,
// and a slow zone is the slowest run of two stretches in a row on it, timed
// over a week, stops included. The layovers at the ends of a route don't count,
// and neither does a stretch with only a few readings.
//
// - slow-zones.json, hourly with the speed files: the slowest zones of the past
//   seven days, for the site's system map.
// - A weekly post on the bus and metro accounts (Sundays, for the Sunday–Saturday
//   week just ended): the five slowest stretches with a map, and a reply with
//   the routes whose average speed changed most from the week before.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../collector/lib/files.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { recapWindow } from '../lib/clock.js';
import { locateAlong, measureShape, sliceAlong } from '../lib/geo.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits, linkFacets } from '../lib/text.js';
import { renderSlowZoneMap } from '../map/slowZoneMap.js';
import { speedStandings } from './halloffame.js';
import { storedWeeks } from './scorecards.js';
import { buildSpeedFiles } from './speedhistory.js';
import { inService, SPEED_CONFIG } from './speedmaps.js';

export const SLOW_ZONES_FILE = 'slow-zones.json';
export const SLOW = {
  version: 1,
  // Stretches in a row that make a zone.
  window: 2,
  // Readings a zone needs (a reading is one vehicle's move between two reports).
  minReadings: 40,
  // Zones kept in the file, per mode.
  perMode: { bus: 40, metro: 12 },
  // In the weekly post: listed in the text, drawn on the map.
  listed: 5,
  mapped: 10,
  // A route's average must move this much (mph, and as a share) to be a change.
  minChangeMph: 0.5,
  minChangeShare: 0.05,
  changesListed: 3,
};
const MODES = { bus: SPEED_CONFIG.bus, metro: SPEED_CONFIG.metro };
const ACCOUNT = {
  bus: { mode: 'bus', what: 'SEPTA buses', head: 'Slowest bus stretches' },
  metro: { mode: 'metro', what: 'SEPTA Metro', head: 'Slowest SEPTA Metro stretches' },
};
const SITE_HOST = new URL(SITE_ORIGIN).host;
const MAP_URL = `${SITE_ORIGIN}/map?layer=slow`;

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

// "Chestnut St & 17th St - FS" → "Chestnut St & 17th St".
const cleanStop = (name) =>
  String(name ?? '')
    .replace(/\s+-\s+[A-Z]{2,5}$/, '')
    .trim();

/**
 * A stretch's name from the stops at its ends: "Chestnut St, 17th St to 12th St"
 * along one street, "A to B" otherwise, "near A" when both ends are one stop.
 */
export function stretchName(from, to) {
  const a = cleanStop(from);
  const b = cleanStop(to);
  if (!a && !b) return null;
  if (!a || !b || a === b) return `near ${a || b}`;
  const [aStreet, aCross] = a.split(/\s+&\s+/);
  const [bStreet, bCross] = b.split(/\s+&\s+/);
  if (aCross && bCross && aStreet === bStreet) return `${aStreet}, ${aCross} to ${bCross}`;
  return `${a} to ${b}`;
}

/**
 * The slowest zone of each direction in a route's speed file (speedhistory's
 * buildSpeedFiles): the slowest run of SLOW.window stretches in a row with
 * data, timed as one (their lengths over the time each took).
 * @param {object} file
 * @param {{ stops?: (route: string, dir: string) => Array<[number, number, string]> } | null} shapes
 */
export function routeSlowZones(file, shapes = null, cfg = SLOW) {
  const speedCfg = MODES[file.mode];
  if (!speedCfg) return [];
  const zones = [];
  for (const d of file.directions) {
    const measured = measureShape(d.shape);
    let best = null;
    for (let i = 0; i + cfg.window <= d.mph.length; i++) {
      let time = 0;
      let readings = 0;
      let ok = true;
      for (let j = i; j < i + cfg.window; j++) {
        if (d.mph[j] == null || !inService(j, d.bin_m, measured.length, speedCfg)) {
          ok = false;
          break;
        }
        time += 1 / d.mph[j];
        readings += d.n[j];
      }
      if (!ok || readings < cfg.minReadings) continue;
      const mph = cfg.window / time;
      if (!best || mph < best.mph) best = { i, mph, readings };
    }
    if (!best) continue;
    const from = best.i * d.bin_m;
    const to = Math.min(measured.length, (best.i + cfg.window) * d.bin_m);
    // The stops nearest each end of the zone, for its name.
    let name = null;
    const stops = shapes?.stops?.(file.route, d.id) ?? [];
    if (stops.length) {
      const nearest = (m) => {
        let pick = null;
        for (const [lat, lon, stopName] of stops) {
          const loc = locateAlong(measured, { lat, lon });
          const gap = Math.abs(loc.along - m);
          if (!pick || gap < pick.gap) pick = { gap, name: stopName };
        }
        return pick?.name ?? null;
      };
      name = stretchName(nearest(from), nearest(to));
    }
    zones.push({
      mode: file.mode,
      route: file.route,
      dir: d.id,
      direction: d.label,
      mph: round(best.mph, 1),
      readings: best.readings,
      length_m: Math.round(to - from),
      name,
      route_mph: d.avg_mph,
      points: sliceAlong(measured, from, to).map(([lat, lon]) => [round(lat, 5), round(lon, 5)]),
    });
  }
  return zones;
}

/**
 * A mode's slow zones over the days fromKey..toKey (the past week when not
 * given), slowest first.
 */
export function slowZones(db, { shapes, mode, now, fromKey = null, toKey = null }) {
  const files = buildSpeedFiles(db, { shapes, now, fromKey, toKey });
  const zones = [];
  for (const file of files.values()) {
    if (file.mode === mode) zones.push(...routeSlowZones(file, shapes));
  }
  return zones.sort(
    (a, b) => a.mph - b.mph || a.route.localeCompare(b.route, 'en', { numeric: true }),
  );
}

/** The slowest zone of each route, slowest first. */
export function onePerRoute(zones) {
  const seen = new Set();
  return zones.filter((z) => !seen.has(z.route) && seen.add(z.route));
}

/** slow-zones.json: the past week's slowest zones of each mode. */
export function buildSlowZones(db, { shapes, now }) {
  const files = buildSpeedFiles(db, { shapes, now });
  const first = files.values().next().value;
  const zones = [];
  for (const mode of Object.keys(MODES)) {
    const found = [];
    for (const file of files.values()) {
      if (file.mode === mode) found.push(...routeSlowZones(file, shapes));
    }
    found.sort((a, b) => a.mph - b.mph);
    zones.push(...found.slice(0, SLOW.perMode[mode]));
  }
  return {
    schema_version: SLOW.version,
    generated_at: now,
    from_day: first?.from_day ?? null,
    to_day: first?.to_day ?? null,
    zones,
  };
}

/** Write slow-zones.json into the data directory (nothing when there are no zones). */
export async function publishSlowZones(db, { dataDir, shapes, now }) {
  const file = buildSlowZones(db, { shapes, now });
  if (!file.zones.length) return { zones: 0 };
  await mkdir(dataDir, { recursive: true });
  await writeFileAtomic(join(dataDir, SLOW_ZONES_FILE), `${JSON.stringify(file)}\n`);
  return { zones: file.zones.length };
}

const mph = (v) => `${v.toFixed(1)} mph`;

/** Text and alt text for the weekly post. */
export function composeSlowZones(account, zones, { label }) {
  const a = ACCOUNT[account];
  const head = `🐢 ${a.head} · ${label}`;
  const where = (z) => (z.name ? ` · ${z.name}` : z.direction ? ` · ${z.direction}` : '');
  const full = (z, i) => `${i + 1}. ${routeShortLabel(a.mode, z.route)}${where(z)} — ${mph(z.mph)}`;
  const bare = (z, i) => `${i + 1}. ${routeShortLabel(a.mode, z.route)} — ${mph(z.mph)}`;
  const notes = [
    `Average over the week, stops included. Map: ${SITE_HOST}/map`,
    `Stops included · ${SITE_HOST}/map`,
  ];
  // Where each stretch is matters more than listing all five.
  const candidates = [];
  for (const fmt of [full, bare]) {
    for (let n = Math.min(zones.length, SLOW.listed); n >= 3; n--) {
      for (const note of notes) {
        candidates.push([head, zones.slice(0, n).map(fmt).join('\n'), note].join('\n\n'));
      }
    }
  }
  const text = firstThatFits(candidates);
  const mapped = zones.slice(0, SLOW.mapped);
  return {
    text,
    facets: linkFacets(text, [{ text: `${SITE_HOST}/map`, uri: MAP_URL }]),
    alt: `Map of the slowest stretches on ${a.what}, ${label}, numbered slowest first: ${mapped
      .map(
        (z, i) =>
          `${i + 1}. ${routeShortLabel(a.mode, z.route)}${z.name ? `, ${z.name}` : ''}, ${mph(z.mph)}`,
      )
      .join('; ')}.`,
  };
}

/**
 * The routes whose average speed changed most from the week before: the
 * biggest slowdowns and the biggest gains, each at least SLOW.minChangeMph and
 * SLOW.minChangeShare.
 * @param {Array<{ route: string, value: number }>} current this week's averages
 * @param {Map<string, number>} previous the week before's, by route
 */
export function speedChanges(current, previous, cfg = SLOW) {
  const moved = [];
  for (const { route, value } of current) {
    const before = previous.get(route);
    if (before == null || !(before > 0)) continue;
    const delta = value - before;
    if (Math.abs(delta) < cfg.minChangeMph || Math.abs(delta) / before < cfg.minChangeShare)
      continue;
    moved.push({ route, before, after: value, delta });
  }
  const slower = moved
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, cfg.changesListed);
  const faster = moved
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, cfg.changesListed);
  return { slower, faster };
}

/** The reply's text, or null when no route's speed moved enough. */
export function composeSpeedChanges(account, { slower, faster }) {
  if (!slower.length && !faster.length) return null;
  const { mode } = ACCOUNT[account];
  const line = (emoji) => (m) =>
    `${emoji} ${routeShortLabel(mode, m.route)}: ${m.before.toFixed(1)} → ${mph(m.after)}`;
  const head = 'Average speed by route, against the week before:';
  const both = (n) =>
    [head, ...slower.slice(0, n).map(line('📉')), ...faster.slice(0, n).map(line('📈'))].join('\n');
  return firstThatFits([both(3), both(2), both(1)]);
}

/**
 * Post an account's slowest stretches of the week just ended (once per week),
 * and a reply with the routes whose speed changed most.
 */
export async function postSlowZones({ db, poster, shapes, basemap, account, now, log = () => {} }) {
  const a = ACCOUNT[account];
  if (!a || !poster.client.hasAccount(account)) return null;
  const win = recapWindow('week', now);
  const subject = `slow-zones:${account}:${win.toKey}`;
  if (poster.find(subject, 'slow-zones')) return { skipped: 'posted' };
  const zones = onePerRoute(slowZones(db, { shapes, mode: a.mode, now, ...win }));
  if (zones.length < 3) {
    log(`slow zones: ${account} skipped, only ${zones.length} routes with a zone`);
    return { skipped: 'too-little-data', zones: zones.length };
  }
  const { text, facets, alt } = composeSlowZones(account, zones, win);
  let image = null;
  try {
    image = {
      data: await renderSlowZoneMap({
        zones: zones.slice(0, SLOW.mapped),
        title: `Slowest stretches · ${win.label}`,
        basemap,
      }),
      alt,
    };
  } catch (err) {
    log(`slow zones: map failed: ${err.message}`);
  }
  const res = await poster.post({
    account,
    kind: 'slow-zones',
    subject,
    text,
    facets,
    highlight: 'recap',
    ...(image && { image }),
  });
  const result = { posted: zones.length, url: res.url, changes: 0 };
  // The week before's averages come from its stored scorecard.
  const before = storedWeeks(db, account, 3).find((w) => w.to < win.fromKey);
  if (before) {
    const previous = new Map(
      before.entries
        .filter((e) => e.measures.speed != null)
        .map((e) => [e.route, e.measures.speed]),
    );
    const changes = speedChanges(speedStandings(db, { mode: a.mode, ...win }).entries, previous);
    const reply = composeSpeedChanges(account, changes);
    if (reply) {
      try {
        await poster.post({
          account,
          kind: 'slow-zones-changes',
          subject,
          text: reply,
          reply: res.uri,
        });
        result.changes = changes.slower.length + changes.faster.length;
      } catch (err) {
        log(`slow zones: changes reply failed: ${err.message}`);
      }
    }
  }
  return result;
}
