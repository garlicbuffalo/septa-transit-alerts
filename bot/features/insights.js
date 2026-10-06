// The alerts account is titled "insights" on Bluesky: besides SEPTA's own
// alerts (features/alerts.js), it posts the system-wide picture.
//
// - Reposts of the other accounts' standout posts, which the features that
//   make them tag with a `highlight`: weekly and monthly recaps, cross-route
//   clusters, detections that are a route's worst in 30 days, a route's
//   slowest speed map in 14 days, and the 5 PM system timelapses. A few an
//   hour at most (REPOST_LIMITS).
// - A rough-hour callout, 10 minutes past the hour, when the hour that just
//   ended brought more new disruptions across SEPTA than the same hour on any
//   comparable day (weekday, Saturday, or Sunday) in the past 4 weeks, and
//   well over the usual (ROUGH_HOUR).
// - A daily digest at 9:30 PM and a weekly one Sunday morning: unplanned
//   SEPTA alerts, cancelled trips, gaps and bunching, Regional Rail, elevators
//   out, the hardest-hit routes, and how the day or week compares with usual.
//   Each links to the site's day or week page.
//
// The counts come from the site's archive (every incident the collector has
// kept), so the comparisons work from the archive's first day; Regional Rail's
// on-time share comes from the bot's TrainView tally (rail_trains).
import { easternDateKey, easternParts, easternToEpoch } from '../../collector/lib/time.js';
import { TRIP_CANCELLATIONS } from '../../collector/lib/tripCancellations.js';
import { isPlannedWork } from '../../src/lib/incidents.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { addDays, clockRange, dateRangeLabel, dayLabel } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { routeShortLabel } from '../lib/routes.js';
import { graphemeLength, linkFacets, POST_MAX_GRAPHEMES } from '../lib/text.js';
import { ALERTS_ACCOUNT, alertGate } from './alerts.js';
import { startOfEasternDay } from './history.js';
import { LATE_MIN, railRecapStats } from './rail.js';

export const INSIGHTS_ACCOUNT = ALERTS_ACCOUNT;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SITE_HOST = new URL(SITE_ORIGIN).host;

export const REPOST_LIMITS = {
  perTick: 1,
  perHour: 3,
  perDay: 10,
  // A highlight not reposted by then (over the limits) is left alone.
  maxAgeMs: 3 * HOUR_MS,
};

export const ROUGH_HOUR = {
  minute: 10,
  // At least this many new disruptions, this many times the usual for the
  // hour, and more than on any comparable day in the lookback.
  min: 12,
  factor: 1.5,
  lookbackDays: 28,
  // Comparable days needed before judging.
  minDays: { weekday: 8, Saturday: 3, Sunday: 3 },
  cooldownMs: 3 * HOUR_MS,
  perDay: 2,
};

// Philadelphia times for the digests; the weekly one only on Sundays.
export const DIGEST_SLOTS = {
  day: { hour: 21, minute: 30 },
  week: { weekday: 0, hour: 11, minute: 0 },
};
const DIGEST = {
  day: { lookback: 30, span: '30 days', minPrior: 14, like: Infinity },
  week: { lookback: 8, span: '8 weeks', minPrior: 4, like: 4 },
};
const MIN_LIKE = { weekday: 8, Saturday: 3, Sunday: 3, week: 2 };
// A record needs at least this much to be worth a mention.
const MIN_RECORD = 3;
// Regional Rail's on-time share needs this many trains in the tally.
const MIN_RAIL_TRAINS = 100;

// What each detection source counts as.
const DETECTION_KIND = {
  gap: 'gap',
  bunching: 'bunch',
  'pulse-held': 'stuck',
  'thin-gap': 'missing',
  ghost: 'missing',
  delay: 'late',
  cancellation: 'cancelled',
};
const KINDS = ['alert', 'gap', 'bunch', 'stuck', 'missing', 'late', 'cancelled'];

// What the digests compare with earlier days or weeks.
const METRICS = [
  { most: 'most cancelled trips', more: 'cancelled trips', value: (w) => w.trips, kinds: null },
  { most: 'most SEPTA alerts', more: 'SEPTA alerts', value: (w) => w.alert, kinds: ['alert'] },
  { most: 'most long gaps', more: 'long gaps', value: (w) => w.gap, kinds: ['gap'] },
  { most: 'most bunching', more: 'bunching', value: (w) => w.bunch, kinds: ['bunch'] },
  {
    most: 'most trains late or cancelled',
    more: 'trains late or cancelled',
    value: (w) => w.late + w.cancelled,
    kinds: ['late', 'cancelled'],
  },
];

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
const keyDate = (key) => new Date(`${key}T12:00:00Z`);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const metaKey = (poster, key) => `insights_${key}${poster.dryRun ? '_dry' : ''}`;

/** Epoch ms of a Philadelphia wall-clock time on a date key. */
function at(key, hour = 0, minute = 0) {
  const [y, m, d] = key.split('-').map(Number);
  return easternToEpoch(y, m, d, hour, minute);
}

/** Weekdays compare with weekdays; Saturdays and Sundays with their own. */
export function dayType(key) {
  const wd = keyDate(key).getUTCDay();
  return wd === 0 ? 'Sunday' : wd === 6 ? 'Saturday' : 'weekday';
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The archive's disruptions first seen since `since`, oldest first, as
 * `{ ts, kind, mode, routes }`. Kinds: 'alert' (an unplanned SEPTA alert,
 * once however many networks it spans), 'gap', 'bunch', 'stuck', 'missing'
 * (vehicle detections), 'late' and 'cancelled' (Regional Rail trains).
 * An alert counts when the alerts account would post it (alertGate) and it
 * isn't planned work, so road-work detours and boarding notices don't.
 * Cancelled bus and Metro trips are counted by service day instead
 * (tripsByDate), since SEPTA posts them ahead.
 */
export function disruptionEvents(incidents, since) {
  const events = [];
  const alerts = new Set();
  for (const inc of incidents.values()) {
    const a = inc.official_alert;
    const first = inc.lifecycle?.first_seen_ts;
    if (a && first >= since && !alerts.has(a.id) && alertGate(inc).post && !isPlannedWork(inc)) {
      alerts.add(a.id);
      events.push({ ts: first, kind: 'alert', mode: inc.mode, routes: inc.routes ?? [] });
    }
    for (const det of inc.detections ?? []) {
      const kind = DETECTION_KIND[det.source];
      const ts = det.lifecycle?.first_seen_ts;
      if (!kind || !(ts >= since)) continue;
      const route = det.scope?.route ?? inc.routes?.[0];
      events.push({ ts, kind, mode: inc.mode, routes: route ? [route] : [] });
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/** Cancelled bus and Metro trips per service date ("YYYY-MM-DD" → trips). */
export function tripsByDate(incidents) {
  const out = new Map();
  for (const inc of incidents.values()) {
    const det = inc.detections?.[0];
    if (det?.source !== TRIP_CANCELLATIONS) continue;
    const { service_date: date, cancelled } = det.evidence?.details ?? {};
    if (date && cancelled > 0) out.set(date, (out.get(date) ?? 0) + cancelled);
  }
  return out;
}

/** Events in [from, to): a count per kind, the total, and the events. */
export function tally(events, from, to) {
  const items = events.filter((e) => e.ts >= from && e.ts < to);
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const e of items) counts[e.kind]++;
  return { ...counts, total: items.length, items };
}

/** The routes with the most events, at least `min` each: ["Route 23 (6)", …]. */
export function hardestHit(items, { min = 3, max = 3 } = {}) {
  const byRoute = new Map();
  for (const e of items) {
    for (const route of e.routes) {
      const key = `${e.mode}|${route}`;
      byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
    }
  }
  return [...byRoute]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { numeric: true }))
    .slice(0, max)
    .map(([key, n]) => {
      const [mode, route] = key.split('|');
      return `${routeShortLabel(mode, route)} (${n})`;
    });
}

/**
 * How a value compares with earlier windows: `usual`, the median of the
 * comparable ones (`like`, when there are `minLike`), and `record`, whether
 * it beats every earlier one (`prior`, when there are `minPrior`).
 */
export function compare(value, { like, prior, minLike, minPrior }) {
  return {
    value,
    usual: like.length >= minLike ? median(like) : null,
    record: prior.length >= minPrior && value >= MIN_RECORD && prior.every((v) => value > v),
  };
}

const times = (r) => `${r >= 10 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, '')}×`;

/**
 * The digest's comparison line: one or two standouts ("📈 Most cancelled
 * trips in 30 days, 3× a usual weekday", "📈 Most long gaps in 30 days ·
 * SEPTA alerts 2× a usual weekday"), or a calm-day note.
 */
export function comparisonLine(results, { span, usualName }) {
  const ratio = (r) => (r.usual > 0 ? r.value / r.usual : 0);
  const usually = (r) => `${times(ratio(r))} a usual ${usualName}`;
  const picked = results
    .filter((r) => r.record || (ratio(r) >= 1.5 && r.value - r.usual >= 3))
    .sort((a, b) => Number(b.record) - Number(a.record) || ratio(b) - ratio(a))
    .slice(0, 2);
  // A lone record also says how far over the usual it is.
  const alone = picked.length === 1;
  const standouts = picked.map((r) =>
    r.record
      ? `${r.metric.most} in ${span}${alone && ratio(r) >= 1.5 ? `, ${usually(r)}` : ''}`
      : `${r.metric.more} ${usually(r)}`,
  );
  if (standouts.length) {
    const text = standouts.join(' · ');
    return `📈 ${text[0].toUpperCase()}${text.slice(1)}`;
  }
  const judged = results.filter((r) => r.usual >= 3);
  if (judged.length >= 3 && judged.every((r) => r.value <= r.usual * 0.6)) {
    return `📉 Calmer than a usual ${usualName}`;
  }
  return null;
}

/**
 * Fit a post: the head always, then lines in rank order (lowest first) while
 * the post stays within the limit. A line's text may be a list of versions,
 * longest first; the first that fits is used. Lines keep their section and
 * order; sections are separated by a blank line.
 * @param {string} head
 * @param {Array<Array<{ text: string | string[] | null, rank: number }>>} sections
 */
export function fitSections(head, sections, max = POST_MAX_GRAPHEMES) {
  const chosen = new Map();
  const render = () =>
    [
      head,
      ...sections.map((s) =>
        s
          .filter((l) => chosen.has(l))
          .map((l) => chosen.get(l))
          .join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
  const lines = sections
    .flat()
    .filter((l) => l.text?.length)
    .sort((a, b) => a.rank - b.rank);
  for (const line of lines) {
    for (const version of [line.text].flat()) {
      chosen.set(line, version);
      if (graphemeLength(render()) <= max) break;
      chosen.delete(line);
    }
  }
  return render();
}

/** Active elevator outages, longest first. */
function activeElevators(outages) {
  return [...(outages?.values() ?? [])]
    .filter((o) => o.lifecycle?.active)
    .sort((a, b) => a.lifecycle.first_seen_ts - b.lifecycle.first_seen_ts);
}

// ── Digests ─────────────────────────────────────────────────────────────────

/**
 * The windows a digest covers, current first: today so far and the same
 * stretch of each earlier day, or last Sunday–Saturday week (the site's
 * /week page) and the weeks before it.
 */
function digestWindows(period, now) {
  const today = easternDateKey(now);
  const { lookback } = DIGEST[period];
  if (period === 'day') {
    const { hour, minute } = easternParts(now);
    return Array.from({ length: lookback + 1 }, (_, i) => {
      const key = addDays(today, -i);
      const to = i === 0 ? now : at(key, hour, minute);
      return { key, fromKey: key, toKey: key, from: at(key), to, type: dayType(key) };
    });
  }
  const lastSaturday = addDays(today, -(keyDate(today).getUTCDay() + 1));
  return Array.from({ length: lookback + 1 }, (_, i) => {
    const toKey = addDays(lastSaturday, -7 * i);
    const fromKey = addDays(toKey, -6);
    const to = at(addDays(toKey, 1));
    return { key: fromKey, fromKey, toKey, from: at(fromKey), to, type: 'week' };
  });
}

/**
 * Everything a digest says: the window's counts, how each compares with
 * earlier windows, Regional Rail's on-time share, elevators out now, and the
 * hardest-hit routes.
 * @param {{ period: 'day' | 'week', incidents: Map<string, object>,
 *   outages?: Map<string, object>, db: object, now: number, dataStartTs?: number | null }} opts
 */
export function digestStats({ period, incidents, outages, db, now, dataStartTs = null }) {
  const cfg = DIGEST[period];
  const windows = digestWindows(period, now);
  // A day's margin, so a source running since before the lookback reads as
  // covering all of it.
  const events = disruptionEvents(incidents, windows.at(-1).from - DAY_MS);
  const trips = tripsByDate(incidents);
  const firstTripDate = [...trips.keys()].sort()[0] ?? null;
  const activeDays = new Set(events.map((e) => easternDateKey(e.ts)));
  for (const w of windows) {
    Object.assign(w, tally(events, w.from, w.to));
    w.trips = 0;
    // Whether the collector recorded something every day of the window: one
    // it missed a day of would read as calm, or a record low.
    w.whole = true;
    for (let k = w.fromKey; k <= w.toKey; k = addDays(k, 1)) {
      w.trips += trips.get(k) ?? 0;
      if (!activeDays.has(k)) w.whole = false;
    }
  }
  const firstSeen = {};
  for (const e of events) firstSeen[e.kind] ??= e.ts;
  const [current, ...prior] = windows;
  const results = METRICS.map((metric) => {
    // Earlier windows count from when the archive has this metric at all, so
    // a source added later doesn't make every day look like a record.
    const since = metric.kinds
      ? Math.min(...metric.kinds.map((k) => firstSeen[k] ?? Number.POSITIVE_INFINITY))
      : firstTripDate
        ? at(firstTripDate)
        : Number.POSITIVE_INFINITY;
    const covered = current.whole
      ? prior.filter((w) => w.whole && w.from >= Math.max(since, dataStartTs ?? 0))
      : [];
    const like = covered.filter((w) => w.type === current.type).slice(0, cfg.like);
    return {
      metric,
      ...compare(metric.value(current), {
        like: like.map(metric.value),
        prior: covered.map(metric.value),
        minLike: MIN_LIKE[current.type],
        minPrior: cfg.minPrior,
      }),
    };
  });
  return {
    period,
    current,
    results,
    rail: railRecapStats(db, { fromKey: current.fromKey, toKey: current.toKey }),
    elevators: activeElevators(outages),
    hardest: hardestHit(current.items),
    now,
  };
}

function railLine(rail, w) {
  if (rail?.trains >= MIN_RAIL_TRAINS) {
    return `🚆 Regional Rail: ${Math.round(rail.pct)}% on time (under ${LATE_MIN} min late), ${rail.cancelled} cancelled`;
  }
  if (!w.late && !w.cancelled) return null;
  return `🚆 Regional Rail: ${plural(w.late, 'train')} ${LATE_MIN}+ min late, ${w.cancelled} cancelled`;
}

/** The elevators line, with and without the longest outage. */
function elevatorLine(elevators, now) {
  if (!elevators.length) return null;
  const short = `♿ ${plural(elevators.length, 'elevator')} out`;
  const longest = elevators[0];
  const days = Math.floor((now - longest.lifecycle.first_seen_ts) / DAY_MS);
  const where = longest.station?.name;
  return days >= 2 && where ? [`${short}, longest at ${where} (${days}+ days)`, short] : short;
}

/** The hardest-hit line, naming fewer routes when space is short. */
function hardestLine(hardest) {
  return hardest.map((_, i) => `Hardest hit: ${hardest.slice(0, hardest.length - i).join(' · ')}`);
}

/** The digest's post text, link, and link card. */
export function composeDigest(stats) {
  const { period, current: w, results, rail, elevators, hardest, now } = stats;
  const day = period === 'day';
  const when = day
    ? `${WEEKDAY.format(keyDate(w.key))}, ${dayLabel(w.key)}`
    : dateRangeLabel(w.fromKey, w.toKey);
  const head = `📊 SEPTA ${day ? 'today' : 'last week'} · ${when}`;
  const facts = [
    {
      rank: 1,
      text: w.alert
        ? `⚠️ ${plural(w.alert, 'unplanned SEPTA alert')}`
        : '⚠️ No unplanned SEPTA alerts',
    },
    { rank: 2, text: w.trips ? `🚫 ${plural(w.trips, 'bus and Metro trip')} cancelled` : null },
    {
      rank: 4,
      text:
        w.gap || w.bunch
          ? `🕳️ ${plural(w.gap, 'long gap')} and ${plural(w.bunch, 'bunch', 'bunches')} on buses and trolleys`
          : null,
    },
    { rank: 3, text: railLine(rail, w) },
    { rank: 6, text: elevatorLine(elevators, now) },
  ];
  const usualName = day ? w.type : 'week';
  // The takeaway first, then the numbers.
  const verdict = {
    rank: 0,
    text: comparisonLine(results, { span: DIGEST[period].span, usualName }),
  };
  const url = `${SITE_ORIGIN}/${day ? 'day' : 'week'}/${w.key}`;
  return {
    text: fitSections(head, [[verdict], facts, [{ rank: 5, text: hardestLine(hardest) }]]),
    link: {
      url,
      title: day ? `SEPTA on ${when}` : `SEPTA, week of ${when}`,
      description: day
        ? 'Every alert and disruption of the day, on SEPTA Transit Alerts.'
        : 'Every alert and disruption of the week, on SEPTA Transit Alerts.',
      thumbUrl: `${url}/og.png`,
      fallbackThumbUrl: `${SITE_ORIGIN}/og-image.png`,
    },
  };
}

/** Post a digest now (once per day or week). */
export async function postDigest({
  period,
  incidents,
  outages,
  db,
  poster,
  now,
  dataStartTs,
  log = () => {},
}) {
  if (!poster.client.hasAccount(INSIGHTS_ACCOUNT)) return null;
  const stats = digestStats({ period, incidents, outages, db, now, dataStartTs });
  const subject = `digest:${period}:${stats.current.key}`;
  if (poster.find(subject, 'digest')) return { skipped: 'posted' };
  const w = stats.current;
  if (!w.total && !w.trips && !(stats.rail.trains >= MIN_RAIL_TRAINS)) {
    log(`insights: ${period} digest skipped, nothing recorded`);
    return { skipped: 'no-data' };
  }
  const { text, link } = composeDigest(stats);
  const res = await poster.post({ account: INSIGHTS_ACCOUNT, kind: 'digest', subject, text, link });
  return { posted: period, url: res.url };
}

/** Post the day's digest after its slot, and Sundays the past week's. */
export async function maybePostDigests({ poster, db, now, ...rest }) {
  if (!poster.client.hasAccount(INSIGHTS_ACCOUNT)) return null;
  const today = easternDateKey(now);
  const { hour, minute } = easternParts(now);
  const out = {};
  for (const [period, slot] of Object.entries(DIGEST_SLOTS)) {
    if (hour * 60 + minute < slot.hour * 60 + slot.minute) continue;
    if (slot.weekday != null && keyDate(today).getUTCDay() !== slot.weekday) continue;
    const key = metaKey(poster, `digest_${period}`);
    if (getMeta(db, key) === today) continue;
    setMeta(db, key, today);
    out[period] = await postDigest({ period, poster, db, now, ...rest });
  }
  return Object.keys(out).length ? out : null;
}

// ── Rough hours ─────────────────────────────────────────────────────────────

/**
 * Whether the hour before `end` was a rough one: more new disruptions than
 * the same hour on any comparable day in the lookback, and well over the
 * usual. Null when it wasn't, or there isn't enough history to say.
 */
export function roughHour({ incidents, end, dataStartTs = null, cfg = ROUGH_HOUR }) {
  const start = end - HOUR_MS;
  const key = easternDateKey(start);
  const { hour } = easternParts(start);
  const type = dayType(key);
  const events = disruptionEvents(incidents, at(addDays(key, -cfg.lookbackDays - 1)));
  const current = tally(events, start, end);
  if (current.total < cfg.min) return null;
  // Days count once the vehicle detectors were running (the bulk of events)
  // and the collector saw anything at all that day.
  const since = Math.max(
    dataStartTs ?? 0,
    events.find((e) => e.kind === 'gap' || e.kind === 'bunch')?.ts ?? Number.POSITIVE_INFINITY,
  );
  const activeDays = new Set(events.map((e) => easternDateKey(e.ts)));
  const like = [];
  for (let i = 1; i <= cfg.lookbackDays; i++) {
    const k = addDays(key, -i);
    if (dayType(k) !== type || at(k) < since || !activeDays.has(k)) continue;
    like.push(tally(events, at(k, hour), at(k, hour + 1)).total);
  }
  if (like.length < cfg.minDays[type]) return null;
  const usual = median(like);
  if (current.total < usual * cfg.factor || like.some((n) => n >= current.total)) return null;
  return { start, end, type, usual, weeks: Math.round(cfg.lookbackDays / 7), current };
}

/** Post text and link facets for a rough hour. */
export function composeRoughHour({ start, end, type, usual, weeks, current }) {
  const routes = (kind) =>
    new Set(current.items.filter((e) => e.kind === kind).flatMap((e) => e.routes)).size;
  const parts = (list) =>
    list
      .filter(([n]) => n)
      .map(([n, text]) => text(n))
      .join(', ');
  const vehicles = parts([
    [current.gap, (n) => plural(n, 'long gap')],
    [current.bunch, (n) => plural(n, 'bunch', 'bunches')],
  ]);
  const stuck = routes('stuck');
  const missing = routes('missing');
  const trains = parts([
    [current.late, (n) => `${plural(n, 'train')} ${LATE_MIN}+ min late`],
    [current.cancelled, (n) => `${n} cancelled`],
  ]);
  const day = type === 'weekday' ? 'a weekday' : `a ${type}`;
  const head = `🔥 A rough hour on SEPTA · ${clockRange(start, end)}`;
  const intro = `${current.total} new disruptions, the most at this hour on ${day} in ${weeks} weeks (usually ~${Math.round(usual)}):`;
  const lines = [
    { rank: 1, text: vehicles ? `· ${vehicles}` : null },
    { rank: 3, text: stuck ? `· ${plural(stuck, 'route')} with vehicles stuck` : null },
    {
      rank: 4,
      text: missing ? `· ${plural(missing, 'route')} with vehicles missing from the tracker` : null,
    },
    { rank: 2, text: trains ? `· Regional Rail: ${trains}` : null },
    { rank: 1, text: current.alert ? `· ${plural(current.alert, 'SEPTA alert')}` : null },
  ];
  const hardest = hardestHit(current.items, { min: 2 });
  const tail = [
    { rank: 5, text: hardestLine(hardest) },
    { rank: 0, text: `🔗 ${SITE_HOST}` },
  ];
  const text = fitSections(head, [[{ rank: 0, text: intro }, ...lines], tail]);
  return { text, facets: linkFacets(text, [{ text: SITE_HOST, uri: SITE_ORIGIN }]) };
}

/**
 * Once an hour (ROUGH_HOUR.minute past), post the hour that just ended if it
 * was a rough one, within the cooldown and daily cap.
 */
export async function maybePostRoughHour({
  incidents,
  db,
  poster,
  now,
  dataStartTs,
  log = () => {},
}) {
  if (!poster.client.hasAccount(INSIGHTS_ACCOUNT)) return null;
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (now - hourStart < ROUGH_HOUR.minute * 60_000) return null;
  const key = metaKey(poster, 'rough_hour');
  if (Number(getMeta(db, key)) >= hourStart) return null;
  setMeta(db, key, hourStart);
  const found = roughHour({ incidents, end: hourStart, dataStartTs });
  if (!found) return null;
  const posted = db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE account = ? AND kind = 'rough-hour' AND dry_run = ? AND ts >= ?`,
  );
  const dry = poster.dryRun ? 1 : 0;
  if (posted.get(INSIGHTS_ACCOUNT, dry, now - ROUGH_HOUR.cooldownMs).n > 0) {
    return { skipped: 'cooldown' };
  }
  if (posted.get(INSIGHTS_ACCOUNT, dry, startOfEasternDay(now)).n >= ROUGH_HOUR.perDay) {
    return { skipped: 'daily-cap' };
  }
  const { text, facets } = composeRoughHour(found);
  const res = await poster.post({
    account: INSIGHTS_ACCOUNT,
    kind: 'rough-hour',
    subject: `rough-hour:${new Date(found.start).toISOString().slice(0, 13)}`,
    text,
    facets,
  });
  log(
    `insights: rough hour posted, ${found.current.total} disruptions (usually ~${Math.round(found.usual)})`,
  );
  return { posted: found.current.total, url: res.url };
}

// ── Reposts ─────────────────────────────────────────────────────────────────

/**
 * Repost the other accounts' highlighted posts, oldest first, within
 * REPOST_LIMITS. Only posts made since this feature first ran count, so
 * turning it on doesn't repost a backlog.
 */
export async function repostHighlights({ db, poster, now, log = () => {} }) {
  if (!poster.client.hasAccount(INSIGHTS_ACCOUNT)) return null;
  const sinceKey = metaKey(poster, 'since');
  let since = Number(getMeta(db, sinceKey));
  if (!since) {
    since = now;
    setMeta(db, sinceKey, since);
  }
  const dry = poster.dryRun ? 1 : 0;
  const rows = db
    .prepare(
      `SELECT * FROM posts WHERE highlight IS NOT NULL AND account != ? AND dry_run = ? AND ts >= ?
       ORDER BY ts, id`,
    )
    .all(INSIGHTS_ACCOUNT, dry, Math.max(since, now - REPOST_LIMITS.maxAgeMs));
  const reposts = db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE account = ? AND kind = 'repost' AND dry_run = ? AND ts >= ?`,
  );
  const stats = { reposted: 0 };
  for (const row of rows) {
    const subject = `repost:${row.uri}`;
    if (poster.find(subject, 'repost') || poster.skipped(subject)) continue;
    if (
      stats.reposted >= REPOST_LIMITS.perTick ||
      reposts.get(INSIGHTS_ACCOUNT, dry, now - HOUR_MS).n >= REPOST_LIMITS.perHour ||
      reposts.get(INSIGHTS_ACCOUNT, dry, startOfEasternDay(now)).n >= REPOST_LIMITS.perDay
    ) {
      stats.waiting = (stats.waiting ?? 0) + 1;
      continue;
    }
    try {
      await poster.repost({ account: INSIGHTS_ACCOUNT, subject, of: row });
      stats.reposted++;
    } catch (err) {
      // The client already retried; most likely the post is gone.
      poster.skip(subject, 'failed');
      log(`insights: reposting ${row.kind} ${row.subject} failed: ${err.message}`);
    }
  }
  return stats;
}
