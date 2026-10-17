// Weekly Hall of Fame and Wall of Shame on the mode accounts (bus, metro,
// rail): one thread each Sunday, covering the Sunday–Saturday week just ended.
// The first post is the five best routes or lines, the reply the five worst,
// each with a scorecard.
//
// Routes are ranked by an overall score out of 100 that weighs several
// measures of the week (WEIGHTS):
//
// - Buses and Metro (trolleys, the M1, the L1): the share of vehicle reports
//   on time (route_days, rolled up from the observations), cancelled trips
//   (SEPTA's trip feed, from the collector's incidents), average speed (the
//   speed tallies, speed_bins, behind the site's speed maps; time at stops
//   counts, layovers at the ends of a route don't), and the bunching and long
//   gaps the detectors saw (detection_events). Cancellations, bunching and
//   gaps are counted per reading of the speed tallies (about a minute of a
//   vehicle in service), so a route running twice the buses isn't marked
//   down for having twice the chances to bunch.
// - Regional Rail: the share of trains that ran on time, the share cancelled,
//   the average delay of the trains that ran (all from rail_trains, as in the
//   weekly recap), and average speed.
//
// Each measure is ranked among the routes that have it (0 for the worst, 1 for
// the best, ties shared), and the score is the weighted mean of those ranks.
// Ranks rather than raw values, so no one measure's scale swamps the others:
// a route 2 mph faster and one 20 points more on time are both simply ahead.
// A route without enough data for a measure (on time, before the rollup has a
// day of it) is scored on the rest, if they carry at least FAME.minWeight.
//
// Ten routes are needed to fill both lists. With fewer (Metro has about
// nine lines that report positions) the ranking splits evenly instead, so a
// route is never in both, and with fewer than six there's no thread.
import { easternDateKey } from '../../collector/lib/time.js';
import { TRIP_CANCELLATIONS } from '../../collector/lib/tripCancellations.js';
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { addDays, keyStart, recapWindow } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits } from '../lib/text.js';
import { renderScorecard } from '../map/chart.js';
import { LATE_MIN, MIN_LINE_TRAINS, MIN_RECAP_TRAINS } from './rail.js';
import { MPH_PER_MPS } from './speedmaps.js';

export const FAME = {
  // Routes or lines in each list.
  size: 5,
  // Fewer ranked than this and there's no thread.
  minRanked: 6,
  // A bus or Metro route needs this many speed readings (a reading is one
  // vehicle's move between two reports, about a minute of travel) on this many
  // days of the week to be ranked.
  minReadings: 300,
  minRouteDays: 3,
  // The speed tallies must cover this many days of the week, or the bot
  // wasn't running for most of it.
  minWindowDays: 5,
  // A route's on-time share counts once this many of its reports carried
  // SEPTA's lateness.
  minTimed: 300,
  // A route scored on measures carrying less than this share of the weight
  // isn't ranked.
  minWeight: 0.6,
};

// On time for a bus or Metro vehicle: no more than 1 minute early or 5 minutes
// late, the usual standard for buses. (Regional Rail keeps its recap's
// LATE_MIN.)
export const ON_TIME = { earlyMin: 1, lateMin: 5 };

// The measures behind the score, by account, in the order the scorecard shows
// them. Each weight is a share of the score.
export const WEIGHTS = {
  bus: { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 },
  metro: { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 },
  rail: { onTime: 35, cancelled: 25, delay: 20, speed: 20 },
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (v) => (v > 0 && v < 9.95 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

// For each measure: which way is better, its name in the score's description,
// its scorecard heading and cell, and how a post says it.
const MEASURES = {
  onTime: {
    better: 'high',
    name: 'on time',
    heading: 'On time',
    cell: (e) => pct(e.measures.onTime),
    phrase: (e) => `${pct(e.measures.onTime)} on time`,
  },
  cancelled: {
    better: 'low',
    name: 'cancellations',
    heading: 'Cancelled',
    cell: (e) => (e.rail ? pct(e.measures.cancelled) : String(e.counts.cancelled)),
    phrase: (e) =>
      e.counts.cancelled
        ? `${plural(e.counts.cancelled, e.rail ? 'train' : 'trip')} cancelled`
        : `no ${e.rail ? 'trains' : 'trips'} cancelled`,
  },
  speed: {
    better: 'high',
    name: 'speed',
    heading: 'Mph',
    cell: (e) => e.measures.speed.toFixed(1),
    phrase: (e) => `${e.measures.speed.toFixed(1)} mph`,
  },
  bunching: {
    better: 'low',
    name: 'bunching',
    heading: 'Bunches',
    cell: (e) => String(e.counts.bunching),
    phrase: (e) =>
      e.counts.bunching ? `bunched ${plural(e.counts.bunching, 'time')}` : 'no bunching seen',
  },
  gaps: {
    better: 'low',
    name: 'gaps',
    heading: 'Long gaps',
    cell: (e) => String(e.counts.gaps),
    phrase: (e) => (e.counts.gaps ? plural(e.counts.gaps, 'long gap') : 'no long gaps seen'),
  },
  delay: {
    better: 'low',
    name: 'delays',
    heading: 'Avg late',
    cell: (e) => `${e.measures.delay.toFixed(1)} min`,
    phrase: (e) => `avg ${e.measures.delay.toFixed(1)} min late`,
  },
};

// name heads the posts; what is the plural in chart titles and alt text.
const ACCOUNT = {
  bus: { mode: 'bus', name: 'Bus', what: 'bus routes', noun: 'routes' },
  metro: { mode: 'metro', name: 'SEPTA Metro', what: 'SEPTA Metro lines', noun: 'lines' },
  rail: {
    mode: 'regional_rail',
    name: 'Regional Rail',
    what: 'Regional Rail lines',
    noun: 'lines',
  },
};

const ROUTE_DAYS_KEY = 'route_days_through';

/**
 * Tally each finished Philadelphia day's on-time reports into route_days, once
 * the day is over and while its observations are all still kept (run before
 * they're pruned). A day the observations only partly cover is skipped.
 * @returns {{ days: number }} days tallied
 */
export function rollupRouteDays(db, now) {
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM observations').get().ts;
  if (oldest == null) return { days: 0 };
  const done = getMeta(db, ROUTE_DAYS_KEY);
  const today = easternDateKey(now);
  const tally = db.prepare(`
    INSERT OR REPLACE INTO route_days (day, mode, route, timed, on_time)
    SELECT @day, mode, route, COUNT(late_min), COALESCE(SUM(late_min BETWEEN @early AND @late), 0)
    FROM observations
    WHERE ts >= @from AND ts < @to AND mode IN ('bus', 'metro')
    GROUP BY mode, route
  `);
  let days = 0;
  for (let day = done ? addDays(done, 1) : easternDateKey(oldest); day < today; ) {
    const next = addDays(day, 1);
    const from = keyStart(day);
    db.transaction(() => {
      if (from >= oldest) {
        tally.run({
          day,
          from,
          to: keyStart(next),
          early: -ON_TIME.earlyMin,
          late: ON_TIME.lateMin,
        });
        days++;
      }
      setMeta(db, ROUTE_DAYS_KEY, day);
    })();
    day = next;
  }
  return { days };
}

/**
 * Average speed by route over the days fromKey..toKey (inclusive), for the
 * routes with enough readings. `days` is how many days of the week the
 * tallies cover at all.
 * @returns {{ days: number, entries: Array<{ route: string, value: number, readings: number }> }}
 */
export function speedStandings(db, { mode, fromKey, toKey }) {
  const { days } = db
    .prepare(
      'SELECT COUNT(DISTINCT day) AS days FROM speed_bins WHERE mode = ? AND day BETWEEN ? AND ?',
    )
    .get(mode, fromKey, toKey);
  const rows = db
    .prepare(
      `SELECT route, SUM(dist) AS dist, SUM(dt) AS dt, SUM(n) AS readings,
              COUNT(DISTINCT day) AS days
       FROM speed_bins WHERE mode = ? AND day BETWEEN ? AND ? GROUP BY route`,
    )
    .all(mode, fromKey, toKey);
  const entries = rows
    .filter(
      (r) =>
        r.dt > 0 &&
        r.readings >= FAME.minReadings &&
        r.days >= FAME.minRouteDays &&
        (mode !== 'metro' || METRO_LINES[r.route]),
    )
    .map((r) => ({
      route: r.route,
      value: (r.dist / (r.dt / 1000)) * MPH_PER_MPS,
      readings: r.readings,
    }));
  return { days, entries };
}

/** Each route's count of a detection (bunching, gap) the bot saw in the window. */
function detectionCounts(db, { source, mode, fromKey, toKey }) {
  const rows = db
    .prepare(
      `SELECT route, COUNT(*) AS n FROM detection_events
       WHERE source = ? AND mode = ? AND ts >= ? AND ts < ? GROUP BY route`,
    )
    .all(source, mode, keyStart(fromKey), keyStart(addDays(toKey, 1)));
  return new Map(rows.map((r) => [r.route, r.n]));
}

/** Each route's cancelled trips over the service days fromKey..toKey, from the incidents. */
export function cancelledTrips(incidents, { mode, fromKey, toKey }) {
  const counts = new Map();
  for (const inc of incidents?.values() ?? []) {
    if (inc.mode !== mode || !inc.id?.startsWith(`${TRIP_CANCELLATIONS}-`)) continue;
    const details = inc.detections?.[0]?.evidence?.details;
    const day = details?.service_date;
    if (!details?.cancelled || !day || day < fromKey || day > toKey) continue;
    const route = inc.routes[0];
    counts.set(route, (counts.get(route) ?? 0) + details.cancelled);
  }
  return counts;
}

/**
 * A bus or Metro week's measures, per route with enough speed readings. The
 * cancellations, bunching and gaps are rates per 1,000 readings (for the
 * score); `counts` keeps them as counted (for the posts).
 */
export function transitStandings(db, incidents, { mode, fromKey, toKey }) {
  const speeds = speedStandings(db, { mode, fromKey, toKey });
  const timed = new Map(
    db
      .prepare(
        `SELECT route, SUM(timed) AS timed, SUM(on_time) AS on_time FROM route_days
         WHERE mode = ? AND day BETWEEN ? AND ? GROUP BY route`,
      )
      .all(mode, fromKey, toKey)
      .map((r) => [r.route, r]),
  );
  const bunching = detectionCounts(db, { source: 'bunching', mode, fromKey, toKey });
  const gaps = detectionCounts(db, { source: 'gap', mode, fromKey, toKey });
  const cancelled = cancelledTrips(incidents, { mode, fromKey, toKey });
  const entries = speeds.entries.map((s) => {
    const t = timed.get(s.route);
    const counts = {
      cancelled: cancelled.get(s.route) ?? 0,
      bunching: bunching.get(s.route) ?? 0,
      gaps: gaps.get(s.route) ?? 0,
    };
    const per = (n) => (1000 * n) / s.readings;
    return {
      route: s.route,
      counts,
      measures: {
        onTime: t && t.timed >= FAME.minTimed ? (100 * t.on_time) / t.timed : null,
        cancelled: per(counts.cancelled),
        speed: s.value,
        bunching: per(counts.bunching),
        gaps: per(counts.gaps),
      },
    };
  });
  return { days: speeds.days, entries };
}

/**
 * A Regional Rail week's measures, per line with MIN_LINE_TRAINS or more
 * trains: on time is the share of the trains that ran that were under
 * LATE_MIN late, cancelled the share SEPTA cancelled, delay the average of the
 * worst lateness seen on each train that ran. `trains` is everything the bot
 * saw.
 */
export function railStandings(db, { fromKey, toKey }) {
  const rows = db
    .prepare(
      'SELECT line, max_late, ran, cancelled FROM rail_trains WHERE service_date BETWEEN ? AND ?',
    )
    .all(fromKey, toKey);
  const byLine = new Map();
  for (const r of rows) {
    if (!r.line || !RAIL_LINES[r.line]) continue;
    if (!byLine.has(r.line)) byLine.set(r.line, { trains: 0, cancelled: 0, onTime: 0, late: 0 });
    const l = byLine.get(r.line);
    l.trains++;
    if (!r.ran && r.cancelled) {
      l.cancelled++;
      continue;
    }
    const late = Math.max(0, r.max_late ?? 0);
    l.late += late;
    if (late < LATE_MIN) l.onTime++;
  }
  const speeds = new Map(
    speedStandings(db, { mode: 'regional_rail', fromKey, toKey }).entries.map((s) => [
      s.route,
      s.value,
    ]),
  );
  const entries = [...byLine]
    .filter(([, l]) => l.trains >= MIN_LINE_TRAINS)
    .map(([line, l]) => {
      const ran = l.trains - l.cancelled;
      return {
        route: line,
        rail: true,
        counts: { cancelled: l.cancelled, trains: l.trains },
        measures: {
          onTime: ran ? (100 * l.onTime) / ran : null,
          cancelled: (100 * l.cancelled) / l.trains,
          delay: ran ? l.late / ran : null,
          speed: speeds.get(line) ?? null,
        },
      };
    });
  return { trains: rows.length, entries };
}

/**
 * Score each entry out of 100: each measure ranked among the entries that
 * have it (0 the worst, 1 the best, ties sharing the middle), then the
 * weighted mean of those ranks over the measures the entry has. `parts` keeps
 * the ranks. An entry whose measures carry under FAME.minWeight of the weight
 * is left out.
 * @param {Array<{ route: string, measures: Record<string, number | null> }>} entries
 * @param {Record<string, number>} weights
 * @returns {Array<object>} the entries kept, with `value` (the score) and `parts`
 */
export function scoreEntries(entries, weights) {
  const parts = entries.map(() => ({}));
  for (const key of Object.keys(weights)) {
    const high = MEASURES[key].better === 'high';
    const have = entries.map((e, i) => [e.measures[key], i]).filter(([v]) => v != null);
    for (const [v, i] of have) {
      let ahead = 0;
      for (const [o, j] of have) {
        if (j === i) continue;
        const d = high ? v - o : o - v;
        if (Math.abs(d) < 1e-9) ahead += 0.5;
        else if (d > 0) ahead++;
      }
      parts[i][key] = have.length > 1 ? ahead / (have.length - 1) : 0.5;
    }
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return entries.flatMap((e, i) => {
    let weight = 0;
    let sum = 0;
    for (const [key, w] of Object.entries(weights)) {
      if (parts[i][key] == null) continue;
      weight += w;
      sum += w * parts[i][key];
    }
    if (weight < FAME.minWeight * total) return [];
    return [{ ...e, parts: parts[i], value: (100 * sum) / weight }];
  });
}

/**
 * The measure an entry did best on (fame) or worst on (shame), by its rank;
 * ties go to the measure that weighs more. Only a measure it ranked in the
 * better half on (fame) or the worse half on (shame) counts, so a Wall of
 * Shame route is never singled out for, say, cancellations every route shared;
 * null when there's none.
 */
export function standout(entry, weights, kind) {
  let pick = null;
  for (const key of Object.keys(weights).sort((a, b) => weights[b] - weights[a])) {
    const p = entry.parts[key];
    if (p == null || (kind === 'fame' ? p <= 0.5 : p >= 0.5)) continue;
    if (pick == null || (kind === 'fame' ? p > entry.parts[pick] : p < entry.parts[pick])) {
      pick = key;
    }
  }
  return pick;
}

/**
 * The best and worst of a ranking (higher is better): up to FAME.size of each,
 * fewer when there aren't enough to keep the two lists apart.
 * @returns {{ best: object[], worst: object[] }} best first, and worst first
 */
export function pickEnds(entries) {
  const sorted = [...entries].sort((a, b) => b.value - a.value || a.route.localeCompare(b.route));
  const size = Math.min(FAME.size, Math.floor(sorted.length / 2));
  return {
    best: sorted.slice(0, size),
    worst: sorted.slice(sorted.length - size).reverse(),
  };
}

const labelOf = (spec, route) =>
  spec.mode === 'regional_rail'
    ? (RAIL_LINES[route]?.label ?? route)
    : routeShortLabel(spec.mode, route);
const scoreOf = (e) => String(Math.round(e.value));

/** "on time 30%, cancellations 20%, …": what the score weighs. */
export function weightsText(account) {
  return Object.entries(WEIGHTS[account])
    .map(([key, w]) => `${MEASURES[key].name} ${w}%`)
    .join(', ');
}

const COPY = {
  fame: { emoji: '🏆', title: 'Hall of Fame', intro: 'Best', chart: 'Best' },
  shame: { emoji: '🐌', title: 'Wall of Shame', intro: 'Worst', chart: 'Worst' },
};

const FOOTER = {
  bus: 'Scores weigh on-time running, cancellations, speed, bunching and gaps.',
  metro: 'Scores weigh on-time running, cancellations, speed, bunching and gaps.',
  rail: 'Scores weigh on-time running, cancellations, delays and speed.',
};

/**
 * Text, scorecard, and alt text for one list of the thread.
 * @param {'bus' | 'metro' | 'rail'} account
 * @param {'fame' | 'shame'} kind
 * @param {object[]} entries scored (scoreEntries), in rank order
 * @param {{ label: string, ranked: number }} opts `ranked` is how many routes were scored
 */
export function composeList(account, kind, entries, { label, ranked }) {
  const spec = ACCOUNT[account];
  const weights = WEIGHTS[account];
  const copy = COPY[kind];
  const head = `${copy.emoji} ${spec.name} ${copy.title} · ${label}`;
  const intro = `${copy.intro} of ${ranked} ${spec.noun}, scored out of 100:`;
  const lines = entries.map((e, i) => {
    const key = standout(e, weights, kind);
    return `${i + 1}. ${labelOf(spec, e.route)} — ${scoreOf(e)}${key ? ` · ${MEASURES[key].phrase(e)}` : ''}`;
  });
  const bare = entries.map((e, i) => `${i + 1}. ${labelOf(spec, e.route)} — ${scoreOf(e)}`);
  const text = firstThatFits([
    [head, [intro, ...lines].join('\n'), FOOTER[account]].join('\n\n'),
    [head, [intro, ...lines].join('\n')].join('\n\n'),
    [head, lines.join('\n')].join('\n\n'),
    [head, [intro, ...bare].join('\n')].join('\n\n'),
    [head, bare.join('\n')].join('\n\n'),
  ]);
  const keys = Object.keys(weights);
  const cellText = (e, key) => (e.measures[key] == null ? '–' : MEASURES[key].cell(e));
  const chart = {
    title: `${copy.chart} ${spec.what} · ${label}`,
    subtitle: `Score out of 100: ${weightsText(account)}`,
    columns: keys.map((key) => MEASURES[key].heading),
    rows: entries.map((e) => {
      const strong = standout(e, weights, kind);
      return {
        label: labelOf(spec, e.route),
        score: e.value,
        display: scoreOf(e),
        cells: keys.map((key) => ({ text: cellText(e, key), strong: key === strong })),
      };
    }),
    note:
      account === 'rail'
        ? `Each ranked against the week's ${ranked} lines · on time: under ${LATE_MIN} min late · SEPTA TrainView`
        : `Each ranked against the week's ${ranked} ${spec.noun} · on time: 1 min early to ${ON_TIME.lateMin} late · SEPTA`,
  };
  const described = entries.map(
    (e) =>
      `${labelOf(spec, e.route)} ${scoreOf(e)} (${keys
        .filter((key) => e.measures[key] != null)
        .map((key) => MEASURES[key].phrase(e))
        .join(', ')})`,
  );
  const alt = `Scorecard of the ${entries.length} ${copy.chart.toLowerCase()}-scoring ${spec.what}, ${label}, out of 100, weighing ${weightsText(account)}: ${described.join('; ')}.`;
  return { text, chart, alt };
}

/**
 * Post an account's Hall of Fame and Wall of Shame thread for the week just
 * ended (once per week; a thread that failed after its first post picks up
 * with the reply). `incidents` are the collector's (for cancelled trips).
 */
export async function postHallOfFame({
  db,
  poster,
  account,
  incidents = new Map(),
  now,
  log = () => {},
}) {
  const spec = ACCOUNT[account];
  if (!spec || !poster.client.hasAccount(account)) return null;
  const win = recapWindow('week', now);
  const subject = `halloffame:${account}:${win.toKey}`;
  const fame = poster.find(subject, 'fame');
  if (fame && poster.find(subject, 'shame')) return { skipped: 'posted' };

  let standings;
  if (account === 'rail') {
    standings = railStandings(db, win);
    if (standings.trains < MIN_RECAP_TRAINS) {
      log(`halloffame: ${account} skipped, only ${standings.trains} trains recorded`);
      return { skipped: 'too-little-data', trains: standings.trains };
    }
  } else {
    standings = transitStandings(db, incidents, { mode: spec.mode, ...win });
    if (standings.days < FAME.minWindowDays) {
      log(`halloffame: ${account} skipped, speeds cover only ${standings.days} days`);
      return { skipped: 'too-little-data', days: standings.days };
    }
  }
  const entries = scoreEntries(standings.entries, WEIGHTS[account]);
  if (entries.length < FAME.minRanked) {
    log(`halloffame: ${account} skipped, only ${entries.length} ${spec.noun} ranked`);
    return { skipped: 'too-few-routes', ranked: entries.length };
  }

  const { best, worst } = pickEnds(entries);
  const opts = { label: win.label, ranked: entries.length };
  const image = async (list) => {
    try {
      return { data: await renderScorecard(list.chart), alt: list.alt };
    } catch (err) {
      log(`halloffame: scorecard failed: ${err.message}`);
      return null;
    }
  };

  let parent = fame;
  if (!parent) {
    const list = composeList(account, 'fame', best, opts);
    const img = await image(list);
    parent = await poster.post({
      account,
      kind: 'fame',
      subject,
      text: list.text,
      ...(img && { image: img }),
    });
  }
  const list = composeList(account, 'shame', worst, opts);
  const img = await image(list);
  const res = await poster.post({
    account,
    kind: 'shame',
    subject,
    text: list.text,
    ...(img && { image: img }),
    reply: parent.uri,
  });
  return { posted: 'week', ranked: entries.length, listed: best.length, url: res.url };
}
