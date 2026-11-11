// Scorecards for the site, from the figures behind the weekly Hall of Fame:
//
// - scorecards.json: every ranked bus route, Metro line and Regional Rail
//   line's score for the last full Sunday–Saturday week, with the measures
//   behind it (features/halloffame.js), and each one's score in earlier weeks.
//   A week is scored once, soon after it ends (the speed tallies behind it are
//   kept only nine days), and kept in scorecard_weeks.
// - rail-trains.json: every Regional Rail train number's record over the past
//   four weeks, from the TrainView tally (rail_trains): how often it ran late,
//   was cancelled, and how late it was each day.
//
// Both are written into the data directory hourly, with the speed files.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../collector/lib/files.js';
import { easternParts, serviceDateKey } from '../../collector/lib/time.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { addDays, recapWindow } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import {
  FAME,
  ON_TIME,
  railStandings,
  scoreEntries,
  transitStandings,
  WEIGHTS,
} from './halloffame.js';
import { MIN_RECAP_TRAINS, ON_TIME_MAX } from './rail.js';

export const SCORECARDS_FILE = 'scorecards.json';
export const RAIL_TRAINS_FILE = 'rail-trains.json';
export const SCORECARDS = {
  version: 1,
  // Weeks of scores kept in the file for each route's trend.
  weeks: 12,
  // A week needs this many routes scored to be kept.
  minRanked: 3,
  publishEveryMs: 60 * 60 * 1000,
  // Service days of trains in rail-trains.json.
  trainDays: 28,
};
const MODES = { bus: 'bus', metro: 'metro', rail: 'regional_rail' };
const PUBLISHED_KEY = 'scorecards_published_ts';
const ROUTE_DAYS_KEY = 'route_days_through';

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * An account's scores for a week: every ranked route with its score, rank,
 * measures, and counts, best first. Null when the bot saw too little of the
 * week to score it.
 * @param {{ fromKey: string, toKey: string }} win
 */
export function weekScores(db, incidents, account, win) {
  let standings;
  if (account === 'rail') {
    standings = railStandings(db, win);
    if (standings.trains < MIN_RECAP_TRAINS) return null;
  } else {
    standings = transitStandings(db, incidents, { mode: MODES[account], ...win });
    if (standings.days < FAME.minWindowDays) return null;
  }
  const scored = scoreEntries(standings.entries, WEIGHTS[account]).sort(
    (a, b) => b.value - a.value || a.route.localeCompare(b.route, 'en', { numeric: true }),
  );
  if (scored.length < SCORECARDS.minRanked) return null;
  return {
    from: win.fromKey,
    to: win.toKey,
    ranked: scored.length,
    entries: scored.map((e, i) => ({
      route: e.route,
      rank: i + 1,
      score: round1(e.value),
      measures: Object.fromEntries(Object.entries(e.measures).map(([k, v]) => [k, round1(v)])),
      counts: e.counts,
    })),
  };
}

/**
 * Score the week just ended for each account that doesn't have it yet. A bus
 * or Metro week waits for its last day's on-time tally (route_days), which the
 * hourly housekeeping makes after midnight.
 * @returns {{ stored: string[] }} the accounts scored this time
 */
export function ensureScorecardWeeks(db, incidents, now) {
  const win = recapWindow('week', now);
  const has = db.prepare('SELECT 1 FROM scorecard_weeks WHERE week_to = ? AND account = ?');
  const put = db.prepare(
    'INSERT OR REPLACE INTO scorecard_weeks (week_to, account, data, ts) VALUES (?, ?, ?, ?)',
  );
  const stored = [];
  for (const account of Object.keys(MODES)) {
    if (has.get(win.toKey, account)) continue;
    if (account !== 'rail' && !((getMeta(db, ROUTE_DAYS_KEY) ?? '') >= win.toKey)) continue;
    const scores = weekScores(db, incidents, account, win);
    if (!scores) continue;
    put.run(win.toKey, account, JSON.stringify(scores), now);
    stored.push(account);
  }
  return { stored };
}

/** The stored weeks for an account, newest first. */
export function storedWeeks(db, account, limit = SCORECARDS.weeks) {
  return db
    .prepare('SELECT data FROM scorecard_weeks WHERE account = ? ORDER BY week_to DESC LIMIT ?')
    .all(account, limit)
    .map((r) => JSON.parse(r.data));
}

/** scorecards.json: the latest week in full, and each route's score by week. */
export function buildScorecards(db, now) {
  const modes = {};
  for (const account of Object.keys(MODES)) {
    const weeks = storedWeeks(db, account);
    if (!weeks.length) continue;
    const history = {};
    for (const [i, w] of weeks.entries()) {
      for (const e of w.entries) {
        history[e.route] ??= Array(weeks.length).fill(null);
        history[e.route][i] = e.score;
      }
    }
    modes[account] = {
      weeks: weeks.map((w) => ({ from: w.from, to: w.to, ranked: w.ranked })),
      latest: weeks[0],
      history,
    };
  }
  return {
    schema_version: SCORECARDS.version,
    generated_at: now,
    weights: WEIGHTS,
    on_time: {
      bus: ON_TIME,
      metro: ON_TIME,
      rail: { lateMin: ON_TIME_MAX },
    },
    modes,
  };
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const mostCommon = (values) => {
  const counts = new Map();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const clockMinutes = (ts) => {
  const { hour, minute } = easternParts(ts);
  return hour * 60 + minute;
};

/**
 * Each Regional Rail train number's record over the service days
 * fromKey..toKey: how many days it was seen, ran, ran on time (never more than
 * ON_TIME_MAX late), ran late, or was cancelled; its average and worst
 * lateness; when it usually first shows on the tracker (minutes past
 * midnight); and each day's worst lateness (-1 cancelled, null not seen).
 */
export function railTrainStats(db, { fromKey, toKey }) {
  const days = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) days.push(k);
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const rows = db
    .prepare('SELECT * FROM rail_trains WHERE service_date BETWEEN ? AND ? ORDER BY service_date')
    .all(fromKey, toKey);
  const byNo = new Map();
  for (const r of rows) {
    if (!byNo.has(r.train_no)) byNo.set(r.train_no, []);
    byNo.get(r.train_no).push(r);
  }
  const trains = [];
  for (const [no, list] of byNo) {
    const daily = Array(days.length).fill(null);
    let ran = 0;
    let onTime = 0;
    let late = 0;
    let cancelled = 0;
    let lateSum = 0;
    let worst = 0;
    for (const r of list) {
      const i = dayIdx.get(r.service_date);
      if (!r.ran && r.cancelled) {
        cancelled++;
        daily[i] = -1;
        continue;
      }
      if (!r.ran) continue;
      const max = Math.max(0, r.max_late ?? 0);
      ran++;
      lateSum += max;
      worst = Math.max(worst, max);
      if (max > ON_TIME_MAX) late++;
      else onTime++;
      daily[i] = max;
    }
    const line = mostCommon(list.map((r) => r.line));
    if (!line || !RAIL_LINES[line] || !(ran + cancelled)) continue;
    trains.push({
      no,
      line,
      origin: list.findLast((r) => r.origin)?.origin ?? null,
      dest: list.findLast((r) => r.dest)?.dest ?? null,
      first_seen_min: median(list.filter((r) => r.ran).map((r) => clockMinutes(r.first_seen))),
      seen: ran + cancelled,
      ran,
      on_time: onTime,
      late,
      cancelled,
      avg_late: ran ? round1(lateSum / ran) : null,
      worst,
      daily,
    });
  }
  trains.sort((a, b) => a.no.localeCompare(b.no, 'en', { numeric: true }));
  return { from: fromKey, to: toKey, days, trains };
}

/** The window rail-trains.json covers: the SCORECARDS.trainDays service days before today's. */
export function trainWindow(now, days = SCORECARDS.trainDays) {
  const toKey = addDays(serviceDateKey(now), -1);
  return { fromKey: addDays(toKey, -(days - 1)), toKey };
}

/** rail-trains.json. */
export function buildRailTrains(db, now) {
  const stats = railTrainStats(db, trainWindow(now));
  return {
    schema_version: SCORECARDS.version,
    generated_at: now,
    on_time_max: ON_TIME_MAX,
    ...stats,
  };
}

/**
 * Score the week just ended if it hasn't been, and write both files into the
 * data directory when the last write is over an hour old. A file with nothing
 * to say yet isn't written.
 * @param {{ dataDir: string, incidents: Map<string, object> | null, now: number }} opts
 */
export async function maybePublishScorecards(db, { dataDir, incidents, now }) {
  const last = Number(getMeta(db, PUBLISHED_KEY) ?? 0);
  if (now - last < SCORECARDS.publishEveryMs) return { skipped: 'recent' };
  const { stored } = incidents ? ensureScorecardWeeks(db, incidents, now) : { stored: [] };
  await mkdir(dataDir, { recursive: true });
  const out = { stored, files: 0 };
  const cards = buildScorecards(db, now);
  if (Object.keys(cards.modes).length) {
    await writeFileAtomic(join(dataDir, SCORECARDS_FILE), `${JSON.stringify(cards)}\n`);
    out.files++;
  }
  const trains = buildRailTrains(db, now);
  if (trains.trains.length) {
    await writeFileAtomic(join(dataDir, RAIL_TRAINS_FILE), `${JSON.stringify(trains)}\n`);
    out.files++;
  }
  setMeta(db, PUBLISHED_KEY, now);
  return out;
}
