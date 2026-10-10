// The Market-Frankford Line's trains, from SEPTA's GTFS-realtime vehicle positions.
//
// TransitView lists the L1 only as schedule placeholders parked at City Hall, but SEPTA's
// GTFS-realtime VehiclePositions feed carries its cars' own GPS: by fleet number (the M-4 cars,
// 1001–1220), with no trip or route. Most trains have two cars reporting. On the El and at
// grade a fix is within a few meters of the line; in the tunnel between Front St and 45th St
// there is no GPS, and the feed repeats each car's last fix, stamped with the time it was
// taken, until the train comes out the other end.
//
// Each call works out, for every car:
//
//   where it is   a fresh fix (under freshMs old) on the line is where it is. A stale fix just
//                 outside a tunnel portal, heading in, is a train underground: it's placed by
//                 the schedule's running times from the portal, stretched by how much longer
//                 trains are taking through the tunnel than scheduled (learned from each run
//                 the feed sees end to end; 12–14% when this was written), and held at the far
//                 portal if it's overdue there. Anything else (a yard, a stale fix elsewhere)
//                 is left out.
//   which way     from its last two fixes, else its bearing against the line, else as before.
//
// then groups cars running together into trains (one vehicle each, named for the lowest car
// number), and matches the trains of each direction to that direction's scheduled trips, in
// order: trains can't pass each other on the line, so the first train is on an earlier trip
// than the second. Matching each train to its nearest trip would not do: at a 10-minute
// headway a train 5 minutes late and the next one 5 minutes early are the same distance from
// the schedule, and only the order says which is which.
//
// The trains come out shaped like normalizeTransitView's vehicles (vehicles.js), with
// `estimated: true` on the ones placed by the schedule. An estimated train is on its trip (its
// lateness counts toward gaps), and is where it should be give or take a couple of hundred
// meters; one overdue at the far portal is also `frozen` — its position is not known — like a
// trolley's repeated fix (vehicleScreen.js).
import metroShapes from '../../src/lib/metroLineShapes.json' with { type: 'json' };

export const SUBWAY_CONFIG = {
  route: 'l1',
  // The M-4 fleet. A car outside these is not an L1 train.
  cars: [[1001, 1220]],
  // A fix this far from the line is in a yard or a shop.
  maxOffLineM: 75,
  // A fix older than this is not where the car is now…
  freshMs: 2 * 60 * 1000,
  // …and one this old just outside a tunnel portal, heading in, is a train underground.
  darkAfterMs: 45 * 1000,
  // The two ends of the tunnel. A car's last fix before going underground is up to a fix's
  // interval out from the portal (SEPTA's cars report every 10–40 seconds).
  portals: {
    east: { name: 'Front St', lat: 39.95268, lon: -75.14132 },
    west: { name: '45th St', lat: 39.95857, lon: -75.20961 },
  },
  approachM: 700,
  insideM: 150,
  // How much longer than scheduled trains take through the tunnel, until the feed has shown
  // some: 12–14% over the four runs seen on 2026-10-10.
  stretch: 1.13,
  stretchRange: [1, 1.5],
  stretchAlpha: 0.3,
  // A train still underground this many times its expected run is lost, not late.
  maxDarkFactor: 1.6,
  // Cars this close along the line, going the same way, are one train (an M-4 train of six
  // cars is about 100 m long).
  trainM: 200,
  // How long a pairing of two cars is remembered, so a car still dark after its partner has
  // come out of the tunnel is known to be on that train.
  mateMs: 3 * 60 * 60 * 1000,
  // Trains this close to a terminal are laying over, side by side: not matched to a trip, and
  // not taken for one train with a car beside them unless the two have run together.
  terminalM: 400,
  // Trip matching: lateness allowed (minutes), how much worse running early is than late, what
  // leaving a train unmatched costs, and what keeping last tick's trip is worth.
  match: { earlyMax: 4, lateMax: 30, earlyWeight: 3, unmatched: 12, keep: 3 },
  // How far around now to look for a train's trip: a late train's trip may have been due to
  // end already, an early one's not yet to start.
  lookBackMs: 45 * 60 * 1000,
  lookAheadMs: 10 * 60 * 1000,
  // What SEPTA's tracker calls each direction.
  directionNames: { 0: 'Eastbound', 1: 'Westbound' },
};

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * A line to measure positions along: meters from its start, which is the Frankford end, so
 * direction 1 (toward 69th St) runs up it and direction 0 down.
 */
export class SubwayLine {
  /** @param {number[][]} points [[lat, lon], …] in either order */
  constructor(points) {
    this.lat0 = points.reduce((s, p) => s + p[0], 0) / points.length;
    this.kx = 111_320 * Math.cos(toRad(this.lat0));
    this.ky = 110_540;
    this.points = points;
    this.xy = points.map(([lat, lon]) => [lon * this.kx, lat * this.ky]);
    this.cum = [0];
    for (let i = 1; i < this.xy.length; i++) {
      const [x1, y1] = this.xy[i - 1];
      const [x2, y2] = this.xy[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(x2 - x1, y2 - y1));
    }
    this.length = this.cum.at(-1);
  }

  /** The same line run the other way. */
  reversed() {
    return new SubwayLine([...this.points].reverse());
  }

  /** { m: meters along, off: meters from the line, bearing: the line's bearing there (up it) }. */
  project(lat, lon) {
    const px = lon * this.kx;
    const py = lat * this.ky;
    let best = { off: Infinity, m: 0, bearing: 0 };
    for (let i = 1; i < this.xy.length; i++) {
      const [x1, y1] = this.xy[i - 1];
      const [x2, y2] = this.xy[i];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
      const off = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (off < best.off) {
        best = {
          off,
          m: this.cum[i - 1] + t * Math.sqrt(len2),
          bearing: (toDeg(Math.atan2(dx, dy)) + 360) % 360,
        };
      }
    }
    return best;
  }

  /** The point `m` meters along the line, { lat, lon, bearing } (bearing up the line). */
  pointAt(m) {
    const at = Math.max(0, Math.min(this.length, m));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < at) i++;
    const span = this.cum[i] - this.cum[i - 1] || 1;
    const f = (at - this.cum[i - 1]) / span;
    const [x1, y1] = this.xy[i - 1];
    const [x2, y2] = this.xy[i];
    return {
      lat: (y1 + f * (y2 - y1)) / this.ky,
      lon: (x1 + f * (x2 - x1)) / this.kx,
      bearing: (toDeg(Math.atan2(x2 - x1, y2 - y1)) + 360) % 360,
    };
  }
}

/**
 * The L1's line: its GTFS shape from the shapes cache, or the site's own (coarser) copy, run from
 * the Frankford end (the Front St portal comes before the 45th St one).
 * @param {import('./shapes.js').RouteShapes | null} shapes
 */
export function subwayLine(shapes, cfg = SUBWAY_CONFIG) {
  const points = shapes?.shape(cfg.route, 1) ?? metroShapes[cfg.route]?.[0] ?? null;
  if (!points || points.length < 2) return null;
  const line = new SubwayLine(points);
  const { east, west } = cfg.portals;
  return line.project(east.lat, east.lon).m <= line.project(west.lat, west.lon).m
    ? line
    : line.reversed();
}

const isCar = (id, cfg) =>
  /^\d+$/.test(id) && cfg.cars.some(([lo, hi]) => Number(id) >= lo && Number(id) <= hi);
// A feed vehicle's car number, or null for a vehicle that isn't an L1 car.
const carOf = (v, cfg) => [v.label, v.vehicleId].map(String).find((id) => isCar(id, cfg)) ?? null;

// Which way a car is going: 1 up the line (toward 69th St), 0 down it, or null.
function directionOf(fix, prev) {
  if (prev && fix.reportTs > prev.reportTs && fix.reportTs - prev.reportTs <= 10 * 60 * 1000) {
    const moved = fix.m - prev.m;
    if (Math.abs(moved) >= 30) return moved > 0 ? 1 : 0;
  }
  if (fix.bearing != null && (fix.speed ?? 0) >= 2) {
    // How far the car's bearing is off the line's (up it), 0–180°.
    const diff = Math.abs(((fix.bearing - fix.lineBearing + 540) % 360) - 180);
    if (diff <= 60) return 1;
    if (diff >= 120) return 0;
  }
  return prev?.dir ?? null;
}

// The scheduled run of a trip, measured along the line: { trip, ms: [m at each stop],
// ts: [time at each stop], stops }.
function profileOf(trip, schedule, line, cache) {
  const key = `${trip.tripId}|${trip.startTs}`;
  if (cache.has(key)) return cache.get(key);
  const st = schedule.stopTimes(trip.tripId);
  let profile = null;
  if (st) {
    const stops = st.stops.map((s) => ({ ...s, m: line.project(s.lat, s.lon).m }));
    profile = {
      trip,
      key,
      stops,
      ms: stops.map((s) => s.m),
      ts: st.secs.map((sec) => trip.midnight + sec * 1000),
    };
  }
  cache.set(key, profile);
  return profile;
}

/** When a trip is scheduled to pass m (ms), or null when m is off its run. */
export function scheduledTimeAt(profile, m) {
  const { ms, ts } = profile;
  for (let i = 1; i < ms.length; i++) {
    const lo = Math.min(ms[i - 1], ms[i]);
    const hi = Math.max(ms[i - 1], ms[i]);
    if (m < lo - 1 || m > hi + 1) continue;
    if (ms[i] === ms[i - 1]) return ts[i - 1];
    return ts[i - 1] + ((ts[i] - ts[i - 1]) * (m - ms[i - 1])) / (ms[i] - ms[i - 1]);
  }
  return null;
}

/** Where a trip is scheduled to be at time t (m along the line), held at its ends. */
export function scheduledPlaceAt(profile, t) {
  const { ms, ts } = profile;
  if (t <= ts[0]) return ms[0];
  for (let i = 1; i < ts.length; i++) {
    if (t > ts[i]) continue;
    const span = ts[i] - ts[i - 1];
    return span ? ms[i - 1] + ((ms[i] - ms[i - 1]) * (t - ts[i - 1])) / span : ms[i];
  }
  return ms.at(-1);
}

// The trips of a direction worth matching against now, with their run along the line.
function candidateTrips(direction, ctx) {
  const { schedule, line, now, cfg, profiles } = ctx;
  return schedule
    .tripsBetween(cfg.route, direction, now - cfg.lookBackMs, now + cfg.lookAheadMs)
    .map((t) => profileOf(t, schedule, line, profiles))
    .filter(Boolean);
}

// The trip whose scheduled passage of m is nearest t (to place a train with no trip yet).
function nearestTrip(trips, m, t) {
  let best = null;
  for (const p of trips) {
    const at = scheduledTimeAt(p, m);
    if (at != null && (!best || Math.abs(t - at) < best.d)) best = { p, d: Math.abs(t - at) };
  }
  return best?.p ?? null;
}

/**
 * Match each direction's trains to its trips, in order (see the top of the file): the
 * assignment, keeping the order of both, that costs least — lateness in minutes, early running
 * `earlyWeight` times over, `unmatched` for a train left without a trip, `keep` off for the
 * trip a train had last time.
 * @param {Array<{ m: number, t: number, prevTrip?: string | null }>} trains leading train first
 * @param {Array<object>} trips profiles, earliest first
 * @returns {Array<{ trip: object, lateMs: number } | null>} per train
 */
export function assignTrips(trains, trips, cfg = SUBWAY_CONFIG) {
  const { earlyMax, lateMax, earlyWeight, unmatched, keep } = cfg.match;
  const n = trains.length;
  const k = trips.length;
  const late = trains.map((tr) =>
    trips.map((p) => {
      const at = scheduledTimeAt(p, tr.m);
      return at == null ? null : tr.t - at;
    }),
  );
  const cost = (i, j) => {
    const l = late[i][j];
    if (l == null) return null;
    const min = l / 60000;
    if (min < -earlyMax || min > lateMax) return null;
    const c = min >= 0 ? min : -min * earlyWeight;
    return trains[i].prevTrip === trips[j].key ? Math.max(0, c - keep) : c;
  };
  // best[i][j]: least cost placing trains[i..] on trips[j..].
  const best = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  const choice = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(null));
  for (let i = n - 1; i >= 0; i--) {
    best[i][k] = best[i + 1][k] + unmatched;
    choice[i][k] = 'skip-train';
    for (let j = k - 1; j >= 0; j--) {
      let b = best[i + 1][j] + unmatched;
      let c = 'skip-train';
      if (best[i][j + 1] < b) {
        b = best[i][j + 1];
        c = 'skip-trip';
      }
      const m = cost(i, j);
      if (m != null && m + best[i + 1][j + 1] < b) {
        b = m + best[i + 1][j + 1];
        c = 'match';
      }
      best[i][j] = b;
      choice[i][j] = c;
    }
  }
  const out = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < n) {
    const c = j < k ? choice[i][j] : 'skip-train';
    if (c === 'match') {
      out[i] = { trip: trips[j], lateMs: late[i][j] };
      i++;
      j++;
    } else if (c === 'skip-trip') j++;
    else i++;
  }
  return out;
}

const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));

/**
 * One tick: the L1's trains from a decoded VehiclePositions feed.
 * @param {ReturnType<import('./gtfsRealtime.js').decodeVehiclePositions>} feed
 * @param {object} opts
 * @param {import('./schedule.js').Schedule} opts.schedule
 * @param {SubwayLine} opts.line subwayLine()
 * @param {object} [opts.state] `state` from the previous call
 * @param {number} opts.now
 * @returns {{ trains: object[], stats: object, state: object }} the trains (vehicles.js's shape,
 *   plus `estimated`, `frozen` and `cars`), counts, and the state to hand the next call (JSON)
 */
export function trackSubway(
  feed,
  { schedule, line, state: prevState = {}, now, cfg = SUBWAY_CONFIG },
) {
  const prev = prevState ?? {};
  const prevCars = prev.cars ?? {};
  const stretch = { 0: cfg.stretch, 1: cfg.stretch, ...(prev.stretch ?? {}) };
  const mates = {};
  for (const [car, mate] of Object.entries(prev.mates ?? {})) {
    if (now - mate.ts <= cfg.mateMs) mates[car] = mate;
  }
  const ctx = { schedule, line, now, cfg, profiles: new Map() };
  const tripsByDir = { 0: candidateTrips(0, ctx), 1: candidateTrips(1, ctx) };
  // Where each direction goes into the tunnel and comes out (m along the line).
  const east = line.project(cfg.portals.east.lat, cfg.portals.east.lon).m;
  const west = line.project(cfg.portals.west.lat, cfg.portals.west.lon).m;
  const inM = { 1: east, 0: west };
  const outM = { 1: west, 0: east };
  const stats = {
    cars: 0,
    gps: 0,
    estimated: 0,
    overdue: 0,
    offLine: 0,
    stale: 0,
    lost: 0,
    learned: 0,
  };
  const nextCars = {};
  const placed = []; // { car, m, dir, t, kind: 'gps' | 'estimated', overdue, fix }

  for (const v of feed?.vehicles ?? []) {
    const car = carOf(v, cfg);
    if (!car) continue;
    stats.cars++;
    const reportTs = v.reportTs ?? feed.timestamp ?? now;
    const proj = line.project(v.lat, v.lon);
    if (proj.off > cfg.maxOffLineM) {
      stats.offLine++;
      continue;
    }
    const fix = { ...v, reportTs, m: proj.m, lineBearing: proj.bearing };
    const before = prevCars[car];
    const dir = directionOf(fix, before);
    const entry = { m: fix.m, reportTs, dir: dir ?? null, dark: before?.dark ?? null };
    // Up the line (toward 69th St) a train goes in at the Front St end and comes out at 45th St.
    const goingIn =
      (dir === 1 && fix.m >= inM[1] - cfg.approachM && fix.m <= inM[1] + cfg.insideM) ||
      (dir === 0 && fix.m <= inM[0] + cfg.approachM && fix.m >= inM[0] - cfg.insideM);
    const age = now - reportTs;

    if (age <= (goingIn ? cfg.darkAfterMs : cfg.freshMs)) {
      // Out of the tunnel: learn how long it took against the schedule.
      const dark = before?.dark;
      if (dark && reportTs > dark.t0 && dir === dark.dir) {
        const out = outM[dark.dir];
        const beyond = dark.dir === 1 ? fix.m >= out - cfg.insideM : fix.m <= out + cfg.insideM;
        const near = Math.abs(fix.m - out) <= cfg.approachM;
        const ref = dark.tripKey ? tripsByDir[dark.dir].find((p) => p.key === dark.tripKey) : null;
        const run = ref ? scheduledTimeAt(ref, fix.m) - scheduledTimeAt(ref, dark.m0) : null;
        if (beyond && near && run > 60_000) {
          const ratio = (reportTs - dark.t0) / run;
          if (ratio >= cfg.stretchRange[0] * 0.9 && ratio <= cfg.stretchRange[1] * 1.1) {
            stretch[dark.dir] = clamp(
              stretch[dark.dir] + cfg.stretchAlpha * (ratio - stretch[dark.dir]),
              cfg.stretchRange,
            );
            stats.learned++;
          }
        }
      }
      entry.dark = null;
      nextCars[car] = entry;
      placed.push({ car, m: fix.m, dir, t: reportTs, kind: 'gps', fix });
      stats.gps++;
      continue;
    }

    // A stale fix: underground if it was taken just outside a portal, heading in.
    if (!goingIn) {
      stats.stale++;
      nextCars[car] = entry;
      continue;
    }
    const trips = tripsByDir[dir];
    const ref =
      (before?.dark?.t0 === reportTs && trips.find((p) => p.key === before.dark.tripKey)) ||
      (prev.trainTrips?.[before?.train] &&
        trips.find((p) => p.key === prev.trainTrips[before.train])) ||
      nearestTrip(trips, fix.m, reportTs);
    entry.dark = ref ? { m0: fix.m, t0: reportTs, dir, tripKey: ref.key } : null;
    nextCars[car] = entry;
    placeDark(car, entry);
  }
  // SEPTA drops a car from the feed about 10 minutes after its last fix, before a train is
  // through the tunnel: a car that went in is placed from its last fix while it's away.
  const inFeed = new Set((feed?.vehicles ?? []).map((v) => carOf(v, cfg)).filter(Boolean));
  for (const [car, entry] of Object.entries(prevCars)) {
    if (inFeed.has(car) || !entry.dark) continue;
    nextCars[car] = { ...entry };
    placeDark(car, nextCars[car]);
  }

  // Place a car underground from where and when it went in (entry.dark), or forget it went in.
  function placeDark(car, entry) {
    const { m0, t0, dir, tripKey } = entry.dark ?? {};
    if (!entry.dark) {
      stats.stale++;
      return;
    }
    // A dark car whose partner has come out is with it: the partner stands for the train.
    const mate = mates[car]?.mate;
    const mateFix = mate ? feed?.vehicles?.find((x) => carOf(x, cfg) === mate) : null;
    if (
      mateFix?.reportTs != null &&
      mateFix.reportTs - t0 > cfg.darkAfterMs &&
      now - mateFix.reportTs <= cfg.freshMs
    ) {
      stats.stale++;
      entry.dark = null;
      return;
    }
    const trips = tripsByDir[dir];
    const ref = trips.find((p) => p.key === tripKey) ?? nearestTrip(trips, m0, t0);
    const farM = outM[dir];
    const t0Sched = ref ? scheduledTimeAt(ref, m0) : null;
    const runToFar = t0Sched != null ? scheduledTimeAt(ref, farM) - t0Sched : null;
    const elapsed = now - t0;
    if (
      runToFar == null ||
      elapsed > Math.max(runToFar, 60_000) * stretch[dir] * cfg.maxDarkFactor
    ) {
      stats.lost++;
      entry.dark = null;
      return;
    }
    let m = scheduledPlaceAt(ref, t0Sched + elapsed / stretch[dir]);
    const overdue = dir === 1 ? m >= farM : m <= farM;
    if (overdue) m = farM;
    entry.dark = { ...entry.dark, tripKey: ref.key };
    placed.push({ car, m, dir, t: now, kind: 'estimated', overdue, fix: null });
    stats.estimated++;
    if (overdue) stats.overdue++;
  }

  // Stations in line order, for the next stop of a train with no trip, and the terminals: a
  // terminal can have a stop for each direction (69th St's departures are ~600 m short of its
  // arrivals), and its zone starts at the one nearer the middle of the line.
  const stops = schedule
    .timedStops(cfg.route)
    .map((st) => ({ name: st.name, m: line.project(st.lat, st.lon).m }))
    .sort((a, b) => a.m - b.m);
  const stations = stops.filter((st, i) => stops.findIndex((x) => x.name === st.name) === i);
  const lowName = stops[0]?.name;
  const highName = stops.at(-1)?.name;
  const firstM = Math.max(0, ...stops.filter((st) => st.name === lowName).map((st) => st.m));
  const lastM = Math.min(
    line.length,
    ...stops.filter((st) => st.name === highName).map((st) => st.m),
  );

  // Cars running together are one train: a car joins the train its known partner is in, else,
  // away from the terminals (where trains lay over side by side), a train just behind it going
  // the same way.
  const atTerminal = (m) => m < firstM + cfg.terminalM || m > lastM - cfg.terminalM;
  const matesWith = (a, b) => mates[a.car]?.mate === b.car || mates[b.car]?.mate === a.car;
  placed.sort((a, b) => a.m - b.m);
  const groups = [];
  for (const p of placed) {
    const near = groups.filter((g) => p.m - g.at(-1).m <= cfg.trainM);
    const dirOf = (g) => g.find((x) => x.dir != null)?.dir ?? null;
    const g =
      near.find((x) => x.some((y) => matesWith(p, y))) ??
      (atTerminal(p.m)
        ? null
        : near.reverse().find((x) => p.dir == null || dirOf(x) == null || dirOf(x) === p.dir));
    if (g) g.push(p);
    else groups.push([p]);
  }
  // Pairs seen running together, remembered for the terminals and the tunnel.
  for (const g of groups) {
    const running = g.filter(
      (p) => p.kind === 'gps' && (p.fix.speed ?? 0) >= 2 && !atTerminal(p.m),
    );
    if (running.length < 2) continue;
    for (const a of running) {
      const b = running
        .filter((x) => x !== a)
        .sort((x, y) => Math.abs(x.m - a.m) - Math.abs(y.m - a.m))[0];
      mates[a.car] = { mate: b.car, ts: now };
    }
  }

  const trains = groups.map((g) => {
    const cars = g.map((p) => p.car).sort((a, b) => Number(a) - Number(b));
    const gps = g.filter((p) => p.kind === 'gps').sort((a, b) => b.t - a.t);
    const lead = gps[0] ?? g[0];
    const votes = g.filter((p) => p.dir != null);
    const dir = votes.length
      ? votes.filter((p) => p.dir === 1).length * 2 >= votes.length
        ? 1
        : 0
      : null;
    const id = `L1-${cars[0]}`;
    return {
      id,
      label: cars[0],
      cars,
      m: lead.m,
      t: lead.t,
      dir,
      estimated: !gps.length,
      overdue: !gps.length && g.every((p) => p.overdue),
      fix: lead.fix,
    };
  });
  for (const tr of trains)
    for (const car of tr.cars) if (nextCars[car]) nextCars[car].train = tr.id;

  // A train near the terminal its direction starts from is laying over, and one past where its
  // direction's trips end has finished: neither is matched to a trip. A terminal has a stop for
  // each direction, and 69th St's are ~600 m apart, with trains waiting to leave near the
  // other direction's.
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const turns = {};
  for (const dir of [0, 1]) {
    const profiles = tripsByDir[dir];
    const from = profiles[0]?.stops[0].name;
    turns[dir] = {
      startMs: stops.filter((st) => st.name === from).map((st) => st.m),
      endM: profiles.length ? median(profiles.map((p) => p.ms.at(-1))) : null,
    };
  }
  const layingOver = (m, dir) => {
    const { startMs, endM } = turns[dir];
    if (startMs.some((sm) => Math.abs(m - sm) < cfg.terminalM)) return true;
    return endM != null && (dir === 1 ? m > endM + 50 : m < endM - 50);
  };

  // Trips, per direction, leading train first.
  const prevTrips = prev.trainTrips ?? {};
  const trainTrips = {};
  for (const dir of [0, 1]) {
    const list = trains
      .filter((tr) => tr.dir === dir && !layingOver(tr.m, dir))
      .sort((a, b) => (dir === 1 ? b.m - a.m : a.m - b.m));
    const assigned = assignTrips(
      list.map((tr) => ({ m: tr.m, t: tr.t, prevTrip: prevTrips[tr.id] ?? null })),
      tripsByDir[dir],
      cfg,
    );
    list.forEach((tr, i) => {
      if (!assigned[i]) return;
      tr.profile = assigned[i].trip;
      tr.lateMs = assigned[i].lateMs;
      trainTrips[tr.id] = assigned[i].trip.key;
    });
  }

  const out = trains.map((tr) => {
    const at = tr.estimated ? line.pointAt(tr.m) : { lat: tr.fix.lat, lon: tr.fix.lon };
    const up = tr.dir === 1;
    const ahead = (m) => (tr.dir == null ? false : up ? m > tr.m + 20 : m < tr.m - 20);
    let nextStop = null;
    if (tr.profile) {
      nextStop = tr.profile.stops.find((s) => ahead(s.m)) ?? tr.profile.stops.at(-1);
    } else if (tr.dir != null) {
      nextStop = (up ? stations : [...stations].reverse()).find((s) => ahead(s.m)) ?? null;
    }
    const trip = tr.profile ? schedule.trip(tr.profile.trip.tripId) : null;
    const lineBearing = line.pointAt(tr.m).bearing;
    const heading =
      tr.estimated || tr.fix.bearing == null
        ? tr.dir == null
          ? null
          : Math.round(up ? lineBearing : (lineBearing + 180) % 360)
        : Math.round(tr.fix.bearing);
    const ends = up ? stations.at(-1) : stations[0];
    return {
      id: tr.id,
      label: tr.label,
      mode: 'metro',
      route: cfg.route,
      tripId: tr.profile?.trip.tripId ?? null,
      directionName: tr.dir == null ? null : cfg.directionNames[tr.dir],
      destination: trip?.destination ?? (tr.dir == null ? null : (ends?.name ?? null)),
      lat: at.lat,
      lon: at.lon,
      heading,
      lateMin: tr.lateMs == null ? null : Math.round(tr.lateMs / 6000) / 10,
      nextStopSequence: tr.profile ? (nextStop?.seq ?? null) : null,
      nextStopName: nextStop?.name ?? null,
      reportTs: tr.t,
      estimated: tr.estimated,
      ...(tr.overdue ? { frozen: true } : {}),
      cars: tr.cars,
    };
  });
  stats.trains = out.length;
  stats.matched = out.filter((v) => v.tripId).length;
  stats.stretch = { 0: Math.round(stretch[0] * 100) / 100, 1: Math.round(stretch[1] * 100) / 100 };
  // Cars not in this feed are remembered a while (a car can drop out of a poll or two).
  for (const [car, entry] of Object.entries(prevCars)) {
    if (!nextCars[car] && now - entry.reportTs <= 60 * 60 * 1000) nextCars[car] = entry;
  }
  return {
    trains: out,
    stats,
    state: { cars: nextCars, stretch, mates, trainTrips },
  };
}
