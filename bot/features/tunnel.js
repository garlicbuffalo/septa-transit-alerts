// Tunnel slowdowns on the metro account. The L1's trains have no GPS between
// Front St and 45th St, so nothing SEPTA publishes shows a slow tunnel. The
// collector does learn how much longer than scheduled trains are taking
// through it (subwayTrains.js: from each train seen going in at one portal and
// coming out at the other, about 13% on an ordinary day), to place the trains
// underground. This posts when that figure jumps: well over both a fixed bar
// and its own recent history, on fresh readings. A ✅ reply follows when it's
// back to usual.
//
// The collector's estimate moves 30% of the way to each new train's time, so
// one slow train doesn't reach the bar; two in a row do.
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { getMeta, setMeta } from '../lib/db.js';
import { linkFacets } from '../lib/text.js';
import { startOfEasternDay } from './history.js';

export const TUNNEL = {
  account: 'metro',
  // Times the scheduled run: the least that's a slowdown…
  minStretch: 1.3,
  // …and how far over the usual it must be.
  overUsual: 0.12,
  // Back to usual within this of it.
  clearWithin: 0.06,
  // The estimate must have moved this recently to be news.
  freshMs: 25 * 60 * 1000,
  // The usual: the median of the past two weeks' readings, at least this many,
  // leaving out the last two hours.
  usualDays: 14,
  usualExcludeMs: 2 * 60 * 60 * 1000,
  minSamples: 20,
  cooldownMs: 3 * 60 * 60 * 1000,
  perDay: 2,
  // A ✅ reply this long after the post would only confuse.
  clearMaxAgeMs: 8 * 60 * 60 * 1000,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_HOST = new URL(SITE_ORIGIN).host;
const LINE_URL = `${SITE_ORIGIN}/line/l1`;
// GTFS direction 1 runs up the line: in at Front St, out at 45th St.
const DIRECTION = {
  0: { name: 'eastbound', toward: 'Frankford', from: '45th St', to: 'Front St' },
  1: { name: 'westbound', toward: '69th St', from: 'Front St', to: '45th St' },
};

const pct = (stretch) => `${Math.round((stretch - 1) * 100)}%`;
const openKey = (poster, dir) => `tunnel_open_${dir}${poster.dryRun ? '_dry' : ''}`;

/**
 * Keep each direction's estimate whenever it has moved (a train was timed).
 * @param {Record<string, number> | null | undefined} stretch the collector's state.subway.stretch
 * @returns {number} readings recorded
 */
export function recordTunnel(db, stretch, now) {
  if (!stretch) return 0;
  const latest = db.prepare(
    'SELECT stretch FROM tunnel_samples WHERE dir = ? ORDER BY ts DESC LIMIT 1',
  );
  const put = db.prepare(
    'INSERT OR REPLACE INTO tunnel_samples (ts, dir, stretch) VALUES (?, ?, ?)',
  );
  let n = 0;
  for (const dir of [0, 1]) {
    const value = Number(stretch[dir]);
    if (!Number.isFinite(value)) continue;
    const prev = latest.get(dir);
    if (prev && Math.abs(prev.stretch - value) < 1e-6) continue;
    put.run(now, dir, value);
    n++;
  }
  return n;
}

/** A direction's latest reading and its usual (null without enough history). */
export function tunnelStatus(db, dir, now, cfg = TUNNEL) {
  const latest = db
    .prepare('SELECT ts, stretch FROM tunnel_samples WHERE dir = ? ORDER BY ts DESC LIMIT 1')
    .get(dir);
  const history = db
    .prepare(
      'SELECT stretch FROM tunnel_samples WHERE dir = ? AND ts >= ? AND ts < ? ORDER BY stretch',
    )
    .all(dir, now - cfg.usualDays * DAY_MS, now - cfg.usualExcludeMs);
  const usual =
    history.length >= cfg.minSamples ? history[Math.floor(history.length / 2)].stretch : null;
  return { latest: latest ?? null, usual };
}

/** The post's text and link facets. */
export function composeTunnel({ dir, stretch, usual }) {
  const d = DIRECTION[dir];
  const text = [
    `🐢 L1 trains are taking about ${pct(stretch)} longer than scheduled through the Market St tunnel, ${d.name} toward ${d.toward} (usually about ${pct(usual)}).`,
    `Timed from trains going in at ${d.from} and coming out at ${d.to}: there's no GPS underground.`,
    `🔗 ${SITE_HOST}/line/l1`,
  ].join('\n\n');
  return { text, facets: linkFacets(text, [{ text: `${SITE_HOST}/line/l1`, uri: LINE_URL }]) };
}

export function composeTunnelClear({ dir, stretch }) {
  const d = DIRECTION[dir];
  return `✅ L1 trains are back to about ${pct(stretch)} over schedule through the tunnel, ${d.name} toward ${d.toward}.`;
}

/**
 * Each tick: record the collector's estimates, post a direction that has
 * slowed, and reply under an earlier post once it's back to usual.
 * @param {{ stretch: Record<string, number> | null, db: object, poster: object, now: number }} opts
 */
export async function maybePostTunnel({ stretch, db, poster, now, log = () => {}, cfg = TUNNEL }) {
  recordTunnel(db, stretch, now);
  if (!poster.client.hasAccount(cfg.account)) return null;
  const dry = poster.dryRun ? 1 : 0;
  const posted = db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE account = ? AND kind = 'tunnel' AND dry_run = ? AND ts >= ?`,
  );
  const out = { posted: 0, cleared: 0 };
  for (const dir of [0, 1]) {
    const { latest, usual } = tunnelStatus(db, dir, now, cfg);
    if (!latest || usual == null) continue;
    const fresh = now - latest.ts <= cfg.freshMs;
    const key = openKey(poster, dir);
    const open = JSON.parse(getMeta(db, key) ?? 'null');
    if (open) {
      if (latest.stretch > usual + cfg.clearWithin) continue;
      setMeta(db, key, null);
      if (now - open.ts > cfg.clearMaxAgeMs) continue;
      try {
        await poster.post({
          account: cfg.account,
          kind: 'tunnel-clear',
          subject: open.subject,
          text: composeTunnelClear({ dir, stretch: latest.stretch }),
          reply: open.uri,
          requireParent: true,
        });
        out.cleared++;
      } catch (err) {
        log(`tunnel: clear reply failed: ${err.message}`);
      }
      continue;
    }
    if (!fresh || latest.stretch < Math.max(cfg.minStretch, usual + cfg.overUsual)) continue;
    if (posted.get(cfg.account, dry, now - cfg.cooldownMs).n > 0) continue;
    if (posted.get(cfg.account, dry, startOfEasternDay(now)).n >= cfg.perDay) continue;
    const subject = `tunnel:${dir}:${new Date(now).toISOString().slice(0, 13)}`;
    const { text, facets } = composeTunnel({ dir, stretch: latest.stretch, usual });
    const res = await poster.post({ account: cfg.account, kind: 'tunnel', subject, text, facets });
    setMeta(db, key, JSON.stringify({ subject, uri: res.uri, ts: now }));
    log(`tunnel: ${DIRECTION[dir].name} slowdown posted, ${pct(latest.stretch)} over schedule`);
    out.posted++;
  }
  return out.posted || out.cleared ? out : null;
}
