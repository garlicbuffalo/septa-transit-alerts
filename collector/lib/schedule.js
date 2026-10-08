// SEPTA bus and Metro schedule, distilled from SEPTA's GTFS for the real-time
// detectors: which trips were scheduled, when each runs, and where it starts
// and ends. The realtime feeds identify trips only by GTFS trip_id, so this is
// what turns "trip 869298 canceled" into "the 6:12 AM Route 16 to 15th-Market".
//
// The bus feed is large (stop_times.txt is ~100 MB), so the collector builds a
// compact index once and caches it (--cache-dir), rebuilding at most daily:
//
//   {
//     version, built_at, feed_version,
//     services: { [service_id]: { days: 'MTWTFSS' as '1111100', start, end,     // YYYYMMDD
//                                 add: [YYYYMMDD], remove: [YYYYMMDD] } },
//     stops: [stop name, …],                 // origin/destination names, by index
//     trips: { [trip_id]: [route, direction_id, service_id, start_sec, end_sec,
//                          origin_stop_idx, dest_stop_idx, last_stop_sequence] },
//   }
//
// `route` is the published route key (classifyRoute) and *_sec are seconds past
// the service date's midnight — GTFS times run past 24:00 for after-midnight
// trips, so a trip belongs to the service date it was scheduled on, not the
// calendar date it runs.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eachCsvRow, GTFS_URL, parseCsvLine, readZip } from './gtfsFiles.js';
import { classifyRoute } from './network.js';
import { buildRouteShapes, SHAPES_FILE, SHAPES_REV } from './shapes.js';
import { easternParts, easternToEpoch } from './time.js';

export const SCHEDULE_VERSION = 1;
const CACHE_FILE = 'schedule-index.json';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

/** "25:04:30" → seconds past the service date's midnight. */
export function gtfsSeconds(clock) {
  const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(clock ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Distill a GTFS feed into the compact schedule index.
 * @param {{ read(name: string): Buffer }} zip google_bus.zip (or any object with read())
 * @param {number} [now]
 */
export function buildScheduleIndex(zip, now = Date.now()) {
  const trips = new Map(); // trip_id → { route, dir, service }
  eachCsvRow(zip.read('trips.txt').toString('utf8'), (r) => {
    const route = classifyRoute(r.route_id);
    if (!route || route.mode === 'regional_rail') return;
    trips.set(r.trip_id, {
      route: route.key,
      dir: Number(r.direction_id) || 0,
      service: r.service_id,
    });
  });

  // stop_times.txt is the big one: scan it line by line, keeping only each
  // trip's first and last stop, without materializing every row.
  const ends = new Map(); // trip_id → [minSeq, startSec, originStop, maxSeq, endSec, destStop]
  const text = zip.read('stop_times.txt').toString('utf8');
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nl = text.indexOf('\n', pos);
  const header = parseCsvLine(text.slice(pos, nl).replace(/\r$/, ''));
  const col = (name) => header.indexOf(name);
  const iTrip = col('trip_id');
  const iArr = col('arrival_time');
  const iDep = col('departure_time');
  const iStop = col('stop_id');
  const iSeq = col('stop_sequence');
  pos = nl + 1;
  while (pos < text.length) {
    nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    pos = nl + 1;
    if (!line) continue;
    const cells = line.includes('"') ? parseCsvLine(line) : line.split(',');
    const tripId = cells[iTrip];
    if (!trips.has(tripId)) continue;
    const seq = Number(cells[iSeq]);
    let e = ends.get(tripId);
    if (!e) {
      e = [Infinity, null, null, -Infinity, null, null];
      ends.set(tripId, e);
    }
    if (seq < e[0]) {
      e[0] = seq;
      e[1] = gtfsSeconds(cells[iDep] || cells[iArr]);
      e[2] = cells[iStop];
    }
    if (seq > e[3]) {
      e[3] = seq;
      e[4] = gtfsSeconds(cells[iArr] || cells[iDep]);
      e[5] = cells[iStop];
    }
  }

  const stopNames = new Map();
  eachCsvRow(zip.read('stops.txt').toString('utf8'), (r) => stopNames.set(r.stop_id, r.stop_name));
  const stops = [];
  const stopIdx = new Map();
  const stopRef = (id) => {
    const name = stopNames.get(id) ?? id;
    if (!stopIdx.has(name)) {
      stopIdx.set(name, stops.length);
      stops.push(name);
    }
    return stopIdx.get(name);
  };

  const out = {};
  for (const [tripId, t] of trips) {
    const e = ends.get(tripId);
    if (!e || e[1] == null || e[4] == null) continue;
    out[tripId] = [t.route, t.dir, t.service, e[1], e[4], stopRef(e[2]), stopRef(e[5]), e[3]];
  }

  const services = {};
  const service = (id) => {
    if (!services[id])
      services[id] = { days: '0000000', start: null, end: null, add: [], remove: [] };
    return services[id];
  };
  const calendar = safeRead(zip, 'calendar.txt');
  if (calendar) {
    eachCsvRow(calendar, (r) => {
      const s = service(r.service_id);
      s.days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        .map((d) => (r[d] === '1' ? '1' : '0'))
        .join('');
      s.start = r.start_date;
      s.end = r.end_date;
    });
  }
  const dates = safeRead(zip, 'calendar_dates.txt');
  if (dates) {
    eachCsvRow(dates, (r) => {
      const s = service(r.service_id);
      (r.exception_type === '1' ? s.add : s.remove).push(r.date);
    });
  }

  let feedVersion = null;
  const info = safeRead(zip, 'feed_info.txt');
  if (info) eachCsvRow(info, (r) => (feedVersion = r.feed_version || feedVersion));

  return {
    version: SCHEDULE_VERSION,
    built_at: now,
    feed_version: feedVersion,
    services,
    stops,
    trips: out,
  };
}

function safeRead(zip, name) {
  try {
    return zip.read(name).toString('utf8');
  } catch {
    return null;
  }
}

/** Download SEPTA's GTFS and open the bus/Metro feed inside it. */
export async function downloadBusFeed() {
  const res = await fetch(GTFS_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${GTFS_URL}`);
  const outer = readZip(Buffer.from(await res.arrayBuffer()));
  return readZip(outer.read('google_bus.zip'));
}

/**
 * Whether a cached index can be used as it is: under a day old, and built when the shapes cache
 * held everything it does now (see SHAPES_REV). The second part is so that a collector updated
 * with a new kind of shape data has it on its next tick, not up to a day later.
 */
export function cacheIsCurrent(cached, now) {
  return (
    Boolean(cached) && now - cached.built_at < MAX_CACHE_AGE_MS && cached.shapes_rev === SHAPES_REV
  );
}

/**
 * Load the schedule index: from fixtures (tests), a fresh-enough cache, or by
 * downloading SEPTA's GTFS and rebuilding the cache. Falls back to a stale
 * cache when the download fails; resolves null when there's nothing usable,
 * in which case the schedule-based detectors skip this tick.
 */
export async function loadSchedule({ cacheDir, fixturesDir, now = Date.now(), log = () => {} }) {
  if (fixturesDir) {
    try {
      return Schedule.from(JSON.parse(await readFile(join(fixturesDir, 'schedule.json'), 'utf8')));
    } catch {
      return null;
    }
  }
  let cached = null;
  if (cacheDir) {
    try {
      cached = JSON.parse(await readFile(join(cacheDir, CACHE_FILE), 'utf8'));
      if (cached?.version !== SCHEDULE_VERSION) cached = null;
    } catch {
      cached = null;
    }
  }
  if (cacheIsCurrent(cached, now)) return Schedule.from(cached);
  try {
    const zip = await downloadBusFeed();
    const index = buildScheduleIndex(zip, now);
    // Recorded whether or not the shapes below build: a shapes failure must not have the whole
    // feed downloaded again on every tick.
    index.shapes_rev = SHAPES_REV;
    if (cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      await writeAtomic(join(cacheDir, CACHE_FILE), JSON.stringify(index));
      // Route shapes come from the same download (used by the bot's maps).
      try {
        await writeAtomic(join(cacheDir, SHAPES_FILE), JSON.stringify(buildRouteShapes(zip, now)));
      } catch (err) {
        log(`schedule: route shapes failed (${err.message})`);
      }
    }
    log(
      `schedule: rebuilt from GTFS ${index.feed_version ?? ''} (${Object.keys(index.trips).length} trips)`,
    );
    return Schedule.from(index);
  } catch (err) {
    log(`schedule: GTFS download failed (${err.message})${cached ? '; using stale cache' : ''}`);
    return cached ? Schedule.from(cached) : null;
  }
}

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

const dateKeyCompact = ({ year, month, day }) =>
  `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;

/** Query helpers over a schedule index. */
export class Schedule {
  static from(index) {
    return index ? new Schedule(index) : null;
  }

  constructor(index) {
    this.index = index;
    this.byRouteDir = new Map(); // `${route}|${dir}` → [{ tripId, service, start, end }] by start
    for (const [tripId, t] of Object.entries(index.trips)) {
      const key = `${t[0]}|${t[1]}`;
      if (!this.byRouteDir.has(key)) this.byRouteDir.set(key, []);
      this.byRouteDir
        .get(key)
        .push({ tripId, service: t[2], start: t[3], end: t[4], origin: t[5] });
    }
    for (const list of this.byRouteDir.values()) list.sort((a, b) => a.start - b.start);
    this.serviceCache = new Map();
  }

  /** Trip details, or null for a trip that isn't in the feed. */
  trip(tripId) {
    const t = this.index.trips[tripId];
    if (!t) return null;
    return {
      tripId,
      route: t[0],
      direction: t[1],
      service: t[2],
      startSec: t[3],
      endSec: t[4],
      origin: this.index.stops[t[5]] ?? null,
      destination: this.index.stops[t[6]] ?? null,
      lastSequence: t[7],
    };
  }

  /** Whether a service runs on a calendar date ({ year, month, day }). */
  serviceRuns(serviceId, date) {
    const key = `${serviceId}|${dateKeyCompact(date)}`;
    if (this.serviceCache.has(key)) return this.serviceCache.get(key);
    const s = this.index.services[serviceId];
    const ymd = dateKeyCompact(date);
    let runs = false;
    if (s) {
      if (s.remove.includes(ymd)) runs = false;
      else if (s.add.includes(ymd)) runs = true;
      else if (s.start && s.end && ymd >= s.start && ymd <= s.end) {
        const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
        runs = s.days[(weekday + 6) % 7] === '1'; // days string starts on Monday
      }
    }
    this.serviceCache.set(key, runs);
    return runs;
  }

  /**
   * The service dates a moment can belong to — its own Eastern calendar date
   * and the day before (for after-midnight trips), plus the day after when
   * `withTomorrow` — each with the moment's offset in seconds past that
   * date's midnight.
   */
  serviceDays(ts, withTomorrow = false) {
    const p = easternParts(ts);
    const shift = (n) => {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    };
    const days = [shift(0), shift(-1)];
    if (withTomorrow) days.push(shift(1));
    return days.map((date) => {
      const midnight = easternToEpoch(date.year, date.month, date.day);
      return { date, midnight, sec: Math.round((ts - midnight) / 1000) };
    });
  }

  /**
   * Scheduled trips for a route+direction running at `ts` (start ≤ ts ≤ end),
   * each with absolute scheduled start/end times.
   */
  activeTrips(route, direction, ts) {
    const list = this.byRouteDir.get(`${route}|${direction}`) ?? [];
    const out = [];
    for (const day of this.serviceDays(ts)) {
      for (const t of list) {
        if (t.start > day.sec) break;
        if (t.end < day.sec || !this.serviceRuns(t.service, day.date)) continue;
        out.push({
          tripId: t.tripId,
          origin: t.origin,
          startTs: day.midnight + t.start * 1000,
          endTs: day.midnight + t.end * 1000,
        });
      }
    }
    return out.sort((a, b) => a.startTs - b.startTs);
  }

  /**
   * Typical scheduled spacing (minutes) between trips of a route+direction
   * around `ts`: the median gap between consecutive scheduled starts within an
   * hour either side. Pass `origin` (a stop index, as on activeTrips entries)
   * to measure one pattern — trips starting from the same stop. Null when
   * fewer than three trips are scheduled then.
   */
  headwayMin(route, direction, ts, origin = null) {
    const list = this.byRouteDir.get(`${route}|${direction}`) ?? [];
    const starts = [];
    for (const day of this.serviceDays(ts)) {
      for (const t of list) {
        if (Math.abs(t.start - day.sec) > 3600) continue;
        if (origin != null && t.origin !== origin) continue;
        if (this.serviceRuns(t.service, day.date)) starts.push(day.midnight + t.start * 1000);
      }
    }
    if (starts.length < 3) return null;
    starts.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < starts.length; i++) gaps.push((starts[i] - starts[i - 1]) / 60000);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  /** Trips a route is scheduled to run (both directions) on a service date. */
  scheduledTripCount(route, date) {
    let n = 0;
    for (const dir of [0, 1]) {
      for (const t of this.byRouteDir.get(`${route}|${dir}`) ?? []) {
        if (this.serviceRuns(t.service, date)) n++;
      }
    }
    return n;
  }

  /**
   * Absolute scheduled start/end of a trip on the service date whose run is
   * nearest `ts` — yesterday's (an after-midnight trip), today's, or
   * tomorrow's (a cancellation published the night before). Null when its
   * service runs on none of them.
   */
  tripTimes(tripId, ts) {
    const t = this.trip(tripId);
    if (!t) return null;
    let best = null;
    for (const day of this.serviceDays(ts, true)) {
      if (!this.serviceRuns(t.service, day.date)) continue;
      const startTs = day.midnight + t.startSec * 1000;
      const endTs = day.midnight + t.endSec * 1000;
      // Prefer the date whose run is closest to now.
      const dist = ts < startTs ? startTs - ts : ts > endTs ? ts - endTs : 0;
      if (!best || dist < best.dist) best = { ...t, startTs, endTs, dist, date: day.date };
    }
    if (!best) return null;
    const { dist: _dist, ...rest } = best;
    return rest;
  }
}
