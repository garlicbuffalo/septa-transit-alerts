// Weekly Hall of Fame and Wall of Shame on the mode accounts (bus, metro,
// rail): one thread each Sunday, covering the Sunday–Saturday week just ended.
// The first post is the five best routes or lines, the reply the five worst,
// each with a bar chart.
//
// - Regional Rail ranks lines by on-time share, the same tally the weekly
//   recap uses (rail_trains).
// - Buses and Metro (trolleys and the M1) have no on-time record the bot
//   keeps past a few days, so they rank by average speed over the week: each
//   route's distance over its time, from the per-day speed tallies
//   (speed_bins) that also feed the site's speed maps. Time at stops counts,
//   layovers at the ends of a route don't.
//
// Ten routes are needed to fill both lists. With fewer (Metro has about
// nine lines that report positions) the ranking splits evenly instead, so a
// route is never in both, and with fewer than six there's no thread.
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { recapWindow } from '../lib/clock.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits } from '../lib/text.js';
import { renderBarChart } from '../map/chart.js';
import { LATE_MIN, MIN_LINE_TRAINS, MIN_RECAP_TRAINS, railRecapStats } from './rail.js';
import { MPH_PER_MPS } from './speedmaps.js';

export const FAME = {
  // Routes or lines in each list.
  size: 5,
  // Fewer ranked than this and there's no thread.
  minRanked: 6,
  // A route needs this many speed readings (a reading is one vehicle's move
  // between two reports, about a minute of travel) on this many days of the
  // week to be ranked.
  minReadings: 300,
  minRouteDays: 3,
  // The speed tallies must cover this many days of the week, or the bot
  // wasn't running for most of it.
  minWindowDays: 5,
};

// name heads the posts; what is the plural in chart titles and alt text.
const ACCOUNT = {
  bus: { mode: 'bus', name: 'Bus', what: 'bus routes', noun: 'routes', metric: 'speed' },
  metro: {
    mode: 'metro',
    name: 'SEPTA Metro',
    what: 'SEPTA Metro lines',
    noun: 'lines',
    metric: 'speed',
  },
  rail: {
    mode: 'regional_rail',
    name: 'Regional Rail',
    what: 'Regional Rail lines',
    noun: 'lines',
    metric: 'ontime',
  },
};

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

/**
 * On-time share by Regional Rail line for the window: the lines with
 * MIN_LINE_TRAINS or more trains. `trains` is everything the bot saw.
 */
export function onTimeStandings(db, win) {
  const stats = railRecapStats(db, win);
  return {
    trains: stats.trains,
    entries: stats.lines.map((l) => ({ route: l.line, value: l.pct, trains: l.trains })),
  };
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
  spec.metric === 'ontime'
    ? (RAIL_LINES[route]?.label ?? route)
    : routeShortLabel(spec.mode, route);
const displayOf = (spec, value) =>
  spec.metric === 'ontime' ? `${value.toFixed(1)}%` : `${value.toFixed(1)} mph`;

// A chart's speed axis: ticks every 5, 10, or 20 mph, up to the top of the bars.
function speedAxis(maxMph) {
  const step = maxMph <= 20 ? 5 : maxMph <= 40 ? 10 : 20;
  const max = Math.max(step, Math.ceil(maxMph / step) * step);
  return { max, ticks: Array.from({ length: max / step + 1 }, (_, i) => i * step) };
}

const COPY = {
  fame: {
    emoji: '🏆',
    title: 'Hall of Fame',
    speed: (noun) => `Fastest ${noun} by average speed:`,
    ontime: (noun) => `Most on-time ${noun} (under ${LATE_MIN} min late, not cancelled):`,
    chart: { speed: 'Fastest', ontime: 'Most on-time' },
  },
  shame: {
    emoji: '🐌',
    title: 'Wall of Shame',
    speed: (noun) => `Slowest ${noun} by average speed:`,
    ontime: (noun) => `Least on-time ${noun} (${LATE_MIN}+ min late or cancelled):`,
    chart: { speed: 'Slowest', ontime: 'Least on-time' },
  },
};

const FOOTER = {
  speed: 'Average speed includes time at stops. Per SEPTA TransitView.',
  ontime: "Counts every train on SEPTA's TrainView.",
};

/**
 * Text, chart, and alt text for one list of the thread.
 * @param {'bus' | 'metro' | 'rail'} account
 * @param {'fame' | 'shame'} kind
 * @param {Array<{ route: string, value: number }>} entries in rank order
 * @param {{ label: string, max?: number }} opts `max` fixes the top of a speed chart's
 *   axis (so both charts of a thread share one scale)
 */
export function composeList(account, kind, entries, { label, max = null }) {
  const spec = ACCOUNT[account];
  const copy = COPY[kind];
  const head = `${copy.emoji} ${spec.name} ${copy.title} · ${label}`;
  const intro = copy[spec.metric](spec.noun);
  const lines = entries.map(
    (e, i) => `${i + 1}. ${labelOf(spec, e.route)} — ${displayOf(spec, e.value)}`,
  );
  const text = firstThatFits([
    [head, [intro, ...lines].join('\n'), FOOTER[spec.metric]].join('\n\n'),
    [head, [intro, ...lines].join('\n')].join('\n\n'),
    [head, lines.join('\n')].join('\n\n'),
  ]);
  const ranked = entries.map((e) => `${labelOf(spec, e.route)} ${displayOf(spec, e.value)}`);
  const chartRows = entries.map((e) => ({
    label: labelOf(spec, e.route),
    value: e.value,
    display: displayOf(spec, e.value),
  }));
  const axis =
    spec.metric === 'ontime'
      ? { max: 100, ticks: [0, 25, 50, 75, 100], tickFormat: (v) => `${v}%` }
      : { ...speedAxis(max ?? Math.max(...entries.map((e) => e.value))), tickFormat: String };
  const chart = {
    title: `${copy.chart[spec.metric]} ${spec.what} · ${label}`,
    subtitle:
      spec.metric === 'ontime'
        ? `Share of trains under ${LATE_MIN} min late and not cancelled`
        : 'Average speed in mph, stops included',
    rows: chartRows,
    ...axis,
    note:
      spec.metric === 'ontime'
        ? `Lines with ${MIN_LINE_TRAINS}+ trains · Source: SEPTA TrainView`
        : 'Source: SEPTA TransitView, as seen by the bot',
  };
  const alt = `Bar chart of the ${entries.length} ${copy.chart[spec.metric].toLowerCase()} ${spec.what}, ${label}: ${ranked.join(', ')}.`;
  return { text, chart, alt };
}

/**
 * Post an account's Hall of Fame and Wall of Shame thread for the week just
 * ended (once per week; a thread that failed after its first post picks up
 * with the reply).
 */
export async function postHallOfFame({ db, poster, account, now, log = () => {} }) {
  const spec = ACCOUNT[account];
  if (!spec || !poster.client.hasAccount(account)) return null;
  const win = recapWindow('week', now);
  const subject = `halloffame:${account}:${win.toKey}`;
  const fame = poster.find(subject, 'fame');
  if (fame && poster.find(subject, 'shame')) return { skipped: 'posted' };

  let entries;
  if (spec.metric === 'ontime') {
    const standings = onTimeStandings(db, win);
    if (standings.trains < MIN_RECAP_TRAINS) {
      log(`halloffame: ${account} skipped, only ${standings.trains} trains recorded`);
      return { skipped: 'too-little-data', trains: standings.trains };
    }
    entries = standings.entries;
  } else {
    const standings = speedStandings(db, { mode: spec.mode, ...win });
    if (standings.days < FAME.minWindowDays) {
      log(`halloffame: ${account} skipped, speeds cover only ${standings.days} days`);
      return { skipped: 'too-little-data', days: standings.days };
    }
    entries = standings.entries;
  }
  if (entries.length < FAME.minRanked) {
    log(`halloffame: ${account} skipped, only ${entries.length} ${spec.noun} ranked`);
    return { skipped: 'too-few-routes', ranked: entries.length };
  }

  const { best, worst } = pickEnds(entries);
  const axis = { label: win.label, max: best[0].value };
  const image = async (list) => {
    try {
      return { data: await renderBarChart(list.chart), alt: list.alt };
    } catch (err) {
      log(`halloffame: chart failed: ${err.message}`);
      return null;
    }
  };

  let parent = fame;
  if (!parent) {
    const list = composeList(account, 'fame', best, axis);
    const img = await image(list);
    parent = await poster.post({
      account,
      kind: 'fame',
      subject,
      text: list.text,
      ...(img && { image: img }),
    });
  }
  const list = composeList(account, 'shame', worst, axis);
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
