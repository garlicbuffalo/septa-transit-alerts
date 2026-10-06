// Cancelled-trip roundups on the bus and metro accounts. SEPTA publishes the
// day's cancelled bus and trolley trips in its real-time trip feed, often
// hours ahead (a run with no operator); the collector keeps one incident per
// route per day. Twice a day, early morning and before the evening rush, each
// account posts the day's count by route, most cancelled first, threaded when
// it runs long. Each route's incident on the site links to the roundup.

import { easternParts, serviceDateKey } from '../../collector/lib/time.js';
import { TRIP_CANCELLATIONS } from '../../collector/lib/tripCancellations.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { clockLabel, dayLabel } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { routeShortLabel } from '../lib/routes.js';
import { linkFacets } from '../lib/text.js';
import { subjectOf } from './detections.js';
import { buildRollupThread } from './ghosts.js';

// Philadelphia times of day (hour, minute) for the roundups.
export const CANCELLATION_SLOTS = [
  [6, 45],
  [14, 45],
];
// Fewer cancelled trips than this in a day: no roundup.
export const MIN_TRIPS = 3;
// Routes listed one by one; the rest are summed in one line (SEPTA can cancel
// 250+ bus trips on 45 routes in a day).
export const MAX_ROUTES = 12;
const SITE_HOST = new URL(SITE_ORIGIN).host;

const ACCOUNTS = {
  bus: { mode: 'bus', what: 'bus trips' },
  metro: { mode: 'metro', what: 'SEPTA Metro trips' },
};

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

/** The latest slot reached today (Philadelphia time), as an index, or -1. */
export function currentSlot(now) {
  const p = easternParts(now);
  const minutes = p.hour * 60 + p.minute;
  let slot = -1;
  CANCELLATION_SLOTS.forEach(([h, m], i) => {
    if (minutes >= h * 60 + m) slot = i;
  });
  return slot;
}

/** The day's cancellation incidents for an account's mode, most trips first. */
export function dayCancellations(incidents, { mode, serviceDate }) {
  const prefix = `${TRIP_CANCELLATIONS}-${serviceDate}-`;
  return [...incidents.values()]
    .filter((inc) => inc.mode === mode && inc.id.startsWith(prefix))
    .map((inc) => ({ inc, det: inc.detections[0], details: inc.detections[0]?.evidence?.details }))
    .filter((x) => x.details?.cancelled > 0)
    .sort(
      (a, b) =>
        b.details.cancelled - a.details.cancelled ||
        a.inc.routes[0].localeCompare(b.inc.routes[0], 'en', { numeric: true }),
    );
}

/**
 * Header, lines, and footer for a roundup. The first line is the summary
 * sentence; `items[i]` is the incident behind `lines[i]` (null for it).
 */
export function composeCancellations(account, items, { serviceDate, now, slot }) {
  const { mode, what } = ACCOUNTS[account];
  const total = items.reduce((t, x) => t + x.details.cancelled, 0);
  const day = `${WEEKDAY.format(new Date(`${serviceDate}T12:00:00Z`))}, ${dayLabel(serviceDate)}`;
  const header = `🚫 Cancelled ${what} · ${day}`;
  const intro = `${slot === 0 ? 'SEPTA has cancelled' : `As of ${clockLabel(now)}, SEPTA has cancelled`} ${total} trip${total === 1 ? '' : 's'} on ${items.length} route${items.length === 1 ? '' : 's'} today:`;
  const listed = items.slice(0, MAX_ROUTES);
  const rest = items.slice(MAX_ROUTES);
  const lines = listed.map(({ inc, details }) => {
    const n = details.cancelled;
    const of = details.scheduled ? ` of ${details.scheduled}` : '';
    return `· ${routeShortLabel(mode, inc.routes[0])}: ${n}${of} trip${n === 1 && !of ? '' : 's'}`;
  });
  if (rest.length) {
    const trips = rest.reduce((t, x) => t + x.details.cancelled, 0);
    lines.push(
      `· …and ${rest.length} more route${rest.length === 1 ? '' : 's'}, ${trips} trip${trips === 1 ? '' : 's'}`,
    );
  }
  return {
    header,
    lines: [intro, ...lines],
    // The summed routes link to the roundup's last post.
    items: [null, ...listed, ...(rest.length ? [rest] : [])],
    total,
    footer: `Per SEPTA's real-time trip feed · 🔗 ${SITE_HOST}`,
  };
}

/**
 * Post each account's roundup when a slot is reached (once per slot a day).
 */
export async function maybePostCancellationRoundups({
  incidents,
  poster,
  db,
  now,
  log = () => {},
}) {
  const slot = currentSlot(now);
  if (slot < 0) return null;
  const serviceDate = serviceDateKey(now);
  const stats = { posts: 0, routes: 0 };
  for (const [account, { mode }] of Object.entries(ACCOUNTS)) {
    if (!poster.client.hasAccount(account)) continue;
    const metaKey = `cancel_roundup_${account}${poster.dryRun ? '_dry' : ''}`;
    const mark = `${serviceDate}#${slot}`;
    if ((getMeta(db, metaKey) ?? '') >= mark) continue;
    setMeta(db, metaKey, mark);
    const items = dayCancellations(incidents, { mode, serviceDate });
    const { header, lines, total, footer, ...composed } = composeCancellations(account, items, {
      serviceDate,
      now,
      slot,
    });
    if (total < MIN_TRIPS) continue;
    const thread = buildRollupThread(header, lines, { footer });
    let parent = null;
    for (const part of thread) {
      try {
        const res = await poster.post({
          account,
          kind: 'cancel-roundup',
          subject: `cancellations:${account}:${mark}`,
          text: part.text,
          facets: linkFacets(part.text, [{ text: SITE_HOST, uri: SITE_ORIGIN }]),
          ...(parent && { reply: parent.uri }),
        });
        parent = res;
        stats.posts++;
        for (const i of part.lines) {
          for (const item of [composed.items[i]].flat()) {
            if (!item) continue;
            poster.alias({ account, kind: 'rollup', subject: subjectOf(item.det), post: res });
            stats.routes++;
          }
        }
      } catch (err) {
        log(`cancellations: roundup post failed: ${err.message}`);
        break;
      }
    }
  }
  return stats;
}
