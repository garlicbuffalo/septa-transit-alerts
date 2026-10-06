// Hourly rollups of routes with scheduled trips missing from SEPTA's tracker
// ("ghost" detections), one thread per account, posted shortly after the hour.
// Each listed detection links to the rollup post on the site. Modeled on
// cta-insights' ghost rollups (ISC).
import { vehicleNoun } from '../../collector/lib/vehicles.js';
import { getMeta, setMeta } from '../lib/db.js';
import { routeEmoji, routeShortLabel } from '../lib/routes.js';
import { graphemeLength, POST_MAX_GRAPHEMES } from '../lib/text.js';
import { accountFor, subjectOf } from './detections.js';

const HOUR_MS = 60 * 60 * 1000;
// Post the hour's rollup this many minutes past the hour.
export const ROLLUP_MINUTE = 7;

const HEADERS = {
  bus: '👻 Missing buses, past hour',
  metro: '👻 Missing SEPTA Metro vehicles, past hour',
};
const FOOTER = '"Missing" = scheduled trips not showing on SEPTA’s tracker.';

/**
 * Split a header and lines into posts of at most 300 graphemes; the footer
 * rides on the first post when it fits. A line too long for any post is cut.
 * @returns {Array<{ text: string, lines: number[] }>} line indexes per post
 */
export function buildRollupThread(header, lines, { footer = null, max = POST_MAX_GRAPHEMES } = {}) {
  const posts = [];
  let cur = { head: header, body: [], lines: [] };
  const render = (p, withFooter) =>
    [p.head, p.body.join('\n'), withFooter && footer ? footer : null].filter(Boolean).join('\n\n');
  lines.forEach((line, i) => {
    const candidate = { ...cur, body: [...cur.body, line], lines: [...cur.lines, i] };
    if (graphemeLength(render(candidate, posts.length === 0)) <= max || cur.body.length === 0) {
      cur = candidate;
    } else {
      posts.push(cur);
      cur = { head: `${header} (cont.)`, body: [line], lines: [i] };
    }
  });
  if (cur.body.length) posts.push(cur);
  return posts.map((p, i) => {
    const withFooter = i === 0 && graphemeLength(render(p, true)) <= max;
    return { text: render(p, withFooter), lines: p.lines };
  });
}

function ghostLine(incident, det) {
  const d = det.evidence?.details ?? {};
  const route = det.scope.route;
  const pct = d.scheduled ? Math.round((d.missing / d.scheduled) * 100) : null;
  const noun = vehicleNoun(incident.mode, route);
  return `${routeEmoji(incident.mode, route)} ${routeShortLabel(incident.mode, route)} · ${d.tracked} of ${d.scheduled} ${noun} on the tracker${pct != null ? ` (${pct}% missing)` : ''}`;
}

/**
 * Once per hour (ROLLUP_MINUTE past), post each account's rollup of ghost
 * detections that opened during the hour and are still open.
 */
export async function maybePostGhostRollups({ incidents, poster, db, now, log = () => {} }) {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (now - hourStart < ROLLUP_MINUTE * 60 * 1000) return null;
  const metaKey = poster.dryRun ? 'ghost_rollup_hour_dry' : 'ghost_rollup_hour';
  if (Number(getMeta(db, metaKey)) >= hourStart) return null;
  setMeta(db, metaKey, hourStart);

  const since = Math.max(hourStart - HOUR_MS + ROLLUP_MINUTE * 60 * 1000, poster.since());
  const byAccount = new Map();
  for (const inc of incidents.values()) {
    for (const det of inc.detections ?? []) {
      if (det.source !== 'ghost' || !det.lifecycle?.active) continue;
      if (det.lifecycle.first_seen_ts < since) continue;
      const account = accountFor(inc.mode);
      if (!account || !poster.client.hasAccount(account)) continue;
      if (poster.find(subjectOf(det), 'rollup')) continue;
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account).push({ inc, det });
    }
  }
  const stats = { posts: 0, routes: 0 };
  for (const [account, items] of byAccount) {
    items.sort(
      (a, b) => (b.det.evidence?.details?.missing ?? 0) - (a.det.evidence?.details?.missing ?? 0),
    );
    const thread = buildRollupThread(
      HEADERS[account],
      items.map(({ inc, det }) => ghostLine(inc, det)),
      { footer: FOOTER },
    );
    let parent = null;
    for (const part of thread) {
      try {
        const res = await poster.post({
          account,
          kind: 'ghost-rollup',
          subject: `ghosts:${account}:${new Date(hourStart).toISOString().slice(0, 13)}`,
          text: part.text,
          ...(parent && { reply: parent.uri }),
        });
        parent = res;
        stats.posts++;
        for (const i of part.lines) {
          poster.alias({ account, kind: 'rollup', subject: subjectOf(items[i].det), post: res });
          stats.routes++;
        }
      } catch (err) {
        log(`ghosts: rollup post failed: ${err.message}`);
        break;
      }
    }
  }
  return stats;
}
