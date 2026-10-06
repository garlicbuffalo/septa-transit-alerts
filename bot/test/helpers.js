// Shared test fixtures for the bot.
import { postUrl } from '../lib/bluesky.js';
import { openDb, setMeta } from '../lib/db.js';
import { createPoster } from '../lib/poster.js';

export const NOW = 1_791_300_000_000; // 2026-10-06T…Z

/** An official incident in the published wire shape. */
export function officialIncident({
  id = 'alert-1',
  alertId = id.replace(/^alert-/, ''),
  mode = 'metro',
  routes = ['l1'],
  headline = 'Westbound trains are delayed.',
  description = null,
  type = 'ALERT',
  cause = 'OTHER_CAUSE',
  effect = 'SIGNIFICANT_DELAYS',
  firstSeen = NOW - 60_000,
  resolvedTs = null,
  scope = null,
  postUrl: post = null,
} = {}) {
  const lifecycle = {
    first_seen_ts: firstSeen,
    resolved_ts: resolvedTs,
    active: resolvedTs == null,
    duration_ms: resolvedTs == null ? null : resolvedTs - firstSeen,
  };
  return {
    id,
    agency: 'septa',
    mode,
    routes,
    sources: ['septa'],
    lifecycle,
    official_alert: {
      id: alertId,
      headline,
      description,
      post_url: post,
      source_url: `https://www.septa.org/schedules/${routes[0]}`,
      resolved_reply_url: null,
      lifecycle: { ...lifecycle },
      scope: scope ?? { from_station: null, to_station: null, stations: [] },
      agency_event_window: null,
      septa: { type, cause, effect, severity: null },
    },
    detections: [],
    status: null,
  };
}

/**
 * A client that behaves like the live one (dryRun: false) without a network:
 * every post gets a bsky-shaped URI and is kept for inspection.
 */
export function fakeLiveClient() {
  const posts = [];
  const reposts = [];
  let n = 0;
  const byUri = new Map();
  return {
    dryRun: false,
    posts,
    reposts,
    hasAccount: () => true,
    async repost(account, subject) {
      const uri = `at://did:plc:${account}/app.bsky.feed.repost/r${++n}`;
      reposts.push({ account, uri, subject });
      return { uri, cid: `c${n}` };
    },
    async post(account, opts) {
      const uri = `at://did:plc:${account}/app.bsky.feed.post/p${++n}`;
      const rec = { account, uri, cid: `c${n}`, opts };
      posts.push(rec);
      byUri.set(uri, rec);
      return { uri, cid: rec.cid, url: postUrl(uri) };
    },
    async getPost(_account, uri) {
      const rec = byUri.get(uri);
      return rec
        ? { uri, cid: rec.cid, value: { text: rec.opts.text, reply: rec.opts.reply } }
        : null;
    },
    async replyRef(_account, uri) {
      const rec = byUri.get(uri);
      if (!rec) return null;
      const root = rec.opts.reply?.root ?? { uri, cid: rec.cid };
      let parent = { uri, cid: rec.cid };
      for (const p of posts)
        if (p.opts.reply?.root?.uri === root.uri) parent = { uri: p.uri, cid: p.cid };
      return { root, parent };
    },
  };
}

/** In-memory database + poster around a client, posting enabled since `since`. */
export function testPoster(client = fakeLiveClient(), { since = NOW - 3_600_000 } = {}) {
  const db = openDb(':memory:');
  setMeta(db, client.dryRun ? 'dry_run_since' : 'live_since', since);
  let t = NOW;
  const poster = createPoster({ db, client, now: () => t });
  return { db, client, poster, setNow: (v) => (t = v) };
}

/** A bot-only vehicle-detection incident in the published wire shape. */
export function detectionIncident({
  id = 'gap-2026-10-06-23-0-1000',
  source = 'gap',
  mode = 'bus',
  route = '23',
  firstSeen = NOW - 60_000,
  resolvedTs = null,
  details = {},
  description = 'detection',
  directionLabel = 'toward 11th-Market',
  fromStation = null,
  onsetTs = null,
  resolvedDescription = null,
  official = null,
} = {}) {
  const lifecycle = {
    first_seen_ts: firstSeen,
    resolved_ts: resolvedTs,
    active: resolvedTs == null,
    duration_ms: resolvedTs == null ? null : resolvedTs - firstSeen,
  };
  const det = {
    id,
    source,
    scope: {
      route,
      from_station: fromStation,
      to_station: null,
      stations: [],
      direction: null,
      direction_label: directionLabel,
    },
    lifecycle: { ...lifecycle, onset_ts: onsetTs },
    post_url: null,
    resolved_post_url: null,
    description,
    evidence: {
      details: { kind: source, ...details },
      bullets: [],
      updates: [],
      resolved_description: resolvedDescription,
    },
  };
  if (official) {
    return { ...official, sources: ['septa', 'bot'], detections: [det] };
  }
  return {
    id,
    agency: 'septa',
    mode,
    routes: [route],
    sources: ['bot'],
    lifecycle,
    official_alert: null,
    detections: [det],
    status: null,
  };
}

/** A normalized vehicle (normalizeTransitView output). */
export function vehicle(over = {}) {
  return {
    id: over.label ?? 'v1',
    label: 'v1',
    mode: 'bus',
    route: '23',
    tripId: 't1',
    directionName: 'Southbound',
    destination: '11th-Market',
    lat: 40.0,
    lon: -75.17,
    heading: 180,
    lateMin: 0,
    nextStopSequence: 20,
    nextStopName: null,
    reportTs: NOW,
    ...over,
  };
}

export const byLabel = (list) => new Map(list.map((v) => [String(v.label), v]));

/** RouteShapes-like stand-in: one straight north–south line per route. */
export function fakeShapes(
  routes = {
    23: [
      [40.05, -75.17],
      [39.95, -75.17],
    ],
  },
) {
  return {
    shape: (route) => routes[route] ?? null,
    shapes: (route) => (routes[route] ? [routes[route]] : []),
  };
}
