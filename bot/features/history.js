// Detection history: every vehicle detection the bots see open is recorded
// (posted or not), which drives daily caps, cooldown overrides, and the
// historical callouts on posts — "📊 3rd Route 17 bunch reported today ·
// biggest gap vs schedule on this route in 30 days". Adapted from
// cta-insights' history.js (ISC).
import { easternParts, easternToEpoch } from '../../collector/lib/time.js';
import { ordinal } from '../lib/text.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// "Biggest in 30 days" needs this many earlier posts to mean anything.
const MIN_HISTORY = 3;

/** Midnight in Philadelphia at the start of `ts`'s day. */
export function startOfEasternDay(ts) {
  const p = easternParts(ts);
  return easternToEpoch(p.year, p.month, p.day);
}

export function recordEvent(db, e) {
  db.prepare(`
    INSERT INTO detection_events (subject, source, mode, route, metric, ratio, near, lat, lon, ts, posted)
    VALUES (@subject, @source, @mode, @route, @metric, @ratio, @near, @lat, @lon, @ts, @posted)
    ON CONFLICT(subject) DO UPDATE SET posted = MAX(posted, excluded.posted)
  `).run({
    ratio: null,
    near: null,
    lat: null,
    lon: null,
    metric: null,
    posted: 0,
    ...e,
  });
}

export function markPosted(db, subject, ts = Date.now()) {
  db.prepare('UPDATE detection_events SET posted = 1, posted_ts = ? WHERE subject = ?').run(
    ts,
    subject,
  );
}

/** Posted events for a source and route since a time. */
export function postedSince(db, { source, route, since }) {
  return db
    .prepare(
      'SELECT * FROM detection_events WHERE source = ? AND route = ? AND posted = 1 AND ts >= ? ORDER BY ts',
    )
    .all(source, route, since);
}

const NOUNS = {
  gap: 'gap',
  bunching: 'bunch',
  'pulse-held': 'stuck-vehicle cluster',
  'thin-gap': 'silent stretch',
  'cross-bunching': 'cluster',
};

const RECORD_PHRASE = {
  gap: 'biggest gap vs schedule on this route in 30 days',
  bunching: 'most vehicles bunched on this route in 30 days',
  'thin-gap': 'longest silence on this route in 30 days',
};

/**
 * Callout phrases for an event about to be posted (call before marking it
 * posted). `score` ranks events: higher is worse.
 * @param {{ source: string, route: string, label: string, ts: number, score: number,
 *   scoreOf?: (row: object) => number }} e
 */
export function callouts(db, { source, route, label, ts, score, scoreOf = (r) => r.metric }) {
  const out = [];
  const dayStart = startOfEasternDay(ts);
  const today = postedSince(db, { source, route, since: dayStart }).length + 1;
  if (today >= 2)
    out.push(`${ordinal(today)} ${label} ${NOUNS[source] ?? 'report'} reported today`);
  const phrase = RECORD_PHRASE[source];
  if (phrase) {
    const prior = postedSince(db, { source, route, since: dayStart - 30 * DAY_MS }).filter(
      (r) => r.ts < dayStart,
    );
    if (prior.length >= MIN_HISTORY && prior.every((r) => score > scoreOf(r))) out.push(phrase);
  }
  return out;
}

export function formatCallouts(list) {
  return list.length ? `📊 ${list.join(' · ')}` : null;
}
