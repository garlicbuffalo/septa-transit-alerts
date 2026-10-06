// Weekly (Sundays) and monthly (the 1st) recaps on the bus and metro
// accounts, adapted from cta-insights' recap bins (ISC): a map of the places
// vehicles bunched most often, then a reply charting the routes with the
// most long gaps. Both count every bunching and gap detection the bot saw
// (detection_events), posted or not.

import { addDays, keyStart, recapWindow } from '../lib/clock.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits } from '../lib/text.js';
import { renderBarChart } from '../map/chart.js';
import { renderHotspotMap } from '../map/hotspotMap.js';

// A place needs this many bunches in the window to count as a hotspot.
export const MIN_SPOT_EVENTS = 3;
const MAX_SPOTS = 40;
const MIN_GAPS = 5;
const CHART_ROUTES = 12;
const CAVEAT = 'Only what the bot saw; real totals may be higher.';

const ACCOUNT = {
  bus: { mode: 'bus', emoji: '🚌', what: 'bus bunching', noun: 'buses' },
  metro: { mode: 'metro', emoji: '🚋', what: 'SEPTA Metro bunching', noun: 'vehicles' },
};

function eventsIn(db, { source, mode, from, to }) {
  return db
    .prepare('SELECT * FROM detection_events WHERE source = ? AND mode = ? AND ts >= ? AND ts < ?')
    .all(source, mode, from, to);
}

/**
 * Group bunching events into places: by the stop they were near, else by
 * position to ~100 m. Places with MIN_SPOT_EVENTS or more, busiest first.
 */
export function bunchingHotspots(events) {
  const spots = new Map();
  for (const e of events) {
    const key = e.near
      ? `n:${e.near.toLowerCase()}`
      : e.lat != null
        ? `p:${e.lat.toFixed(3)},${e.lon.toFixed(3)}`
        : null;
    if (!key) continue;
    if (!spots.has(key)) spots.set(key, { name: e.near, events: [], routes: new Map() });
    const s = spots.get(key);
    s.events.push(e);
    s.routes.set(e.route, (s.routes.get(e.route) ?? 0) + 1);
  }
  return [...spots.values()]
    .filter((s) => s.events.length >= MIN_SPOT_EVENTS)
    .map((s) => {
      const located = s.events.filter((e) => e.lat != null);
      return {
        name: s.name,
        count: s.events.length,
        routes: [...s.routes].sort((a, b) => b[1] - a[1]).map(([r]) => r),
        lat: located.length ? located.reduce((t, e) => t + e.lat, 0) / located.length : null,
        lon: located.length ? located.reduce((t, e) => t + e.lon, 0) / located.length : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

const routesText = (mode, routes) =>
  routes.length === 1
    ? routeShortLabel(mode, routes[0])
    : mode === 'bus'
      ? `Routes ${routes.slice(0, 3).join(', ')}`
      : routes
          .slice(0, 3)
          .map((r) => routeShortLabel(mode, r))
          .join(', ');

/** Text for the hotspot post, listing as many places as fit. */
export function composeHotspots(account, spots, total, label) {
  const a = ACCOUNT[account];
  const head = `${a.emoji} Chronic ${a.what} spots · ${label}`;
  const lines = spots.map(
    (s) => `· ${s.name ?? 'Unnamed stop'} — ${routesText(a.mode, s.routes)} (${s.count})`,
  );
  const intro = `${total} bunches seen; the places it happened most:`;
  const candidates = [];
  for (let n = Math.min(lines.length, 6); n >= 1; n--) {
    candidates.push([head, `${intro}\n${lines.slice(0, n).join('\n')}`, CAVEAT].join('\n\n'));
  }
  const text = firstThatFits(candidates);
  const alt = `Map of the places ${a.noun} bunched most often, ${label}, as bubbles sized by how often: ${spots
    .slice(0, 8)
    .map((s) => `${s.name ?? 'unnamed stop'} (${s.count})`)
    .join(', ')}.`;
  return { text, alt };
}

/** Gap counts by route, most first. */
export function gapsByRoute(events) {
  const counts = new Map();
  for (const e of events) counts.set(e.route, (counts.get(e.route) ?? 0) + 1);
  return [...counts].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count);
}

/** Text, chart, and alt text for the gap post. */
export function composeGaps(account, byRoute, total, label) {
  const a = ACCOUNT[account];
  const head = `⏰ Long gaps between ${a.noun} · ${label}`;
  const lines = byRoute.map((r) => `· ${routeShortLabel(a.mode, r.route)} (${r.count})`);
  const intro = `${total} gaps of more than twice the scheduled spacing, across ${byRoute.length} routes. Most often:`;
  const candidates = [];
  for (let n = Math.min(lines.length, 5); n >= 1; n--) {
    candidates.push([head, `${intro}\n${lines.slice(0, n).join('\n')}`, CAVEAT].join('\n\n'));
  }
  const rows = byRoute.slice(0, CHART_ROUTES).map((r) => ({
    label: routeShortLabel(a.mode, r.route),
    value: r.count,
    display: String(r.count),
  }));
  const most = Math.max(...rows.map((r) => r.value));
  const step = most <= 5 ? 1 : most <= 20 ? 5 : most <= 50 ? 10 : 25;
  const top = Math.ceil(most / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  return {
    text: firstThatFits(candidates),
    chart: {
      title: `Long gaps by route · ${label}`,
      subtitle: `Gaps of more than twice the scheduled spacing, top ${rows.length} routes`,
      rows,
      max: top,
      ticks,
      note: 'Source: SEPTA TransitView, as seen by the bot',
    },
    alt: `Bar chart of long gaps by route, ${label}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}.`,
  };
}

/**
 * Post an account's weekly or monthly recap: the hotspot map, then the gap
 * chart as a reply (or on its own when no place bunched often enough).
 */
export async function postRecap({ db, poster, basemap, account, period, now, log = () => {} }) {
  if (!ACCOUNT[account] || !poster.client.hasAccount(account)) return null;
  const { mode } = ACCOUNT[account];
  const win = recapWindow(period, now);
  const from = keyStart(win.fromKey);
  const to = keyStart(addDays(win.toKey, 1));
  const subject = `recap:${account}:${period}:${win.toKey}`;
  if (poster.find(subject, 'recap') || poster.find(subject, 'recap-gaps')) {
    return { skipped: 'posted' };
  }
  const result = { hotspots: 0, gaps: 0 };
  let parent = null;

  const bunches = eventsIn(db, { source: 'bunching', mode, from, to });
  const spots = bunchingHotspots(bunches);
  if (spots.length) {
    const { text, alt } = composeHotspots(account, spots, bunches.length, win.label);
    const mapped = spots.filter((s) => s.lat != null).slice(0, MAX_SPOTS);
    let image = null;
    if (mapped.length) {
      try {
        image = {
          data: await renderHotspotMap({
            spots: mapped,
            title: `Bunching hotspots · ${win.label}`,
            basemap,
          }),
          alt,
        };
      } catch (err) {
        log(`recaps: hotspot map failed: ${err.message}`);
      }
    }
    parent = await poster.post({ account, kind: 'recap', subject, text, ...(image && { image }) });
    result.hotspots = spots.length;
  }

  const gaps = eventsIn(db, { source: 'gap', mode, from, to });
  if (gaps.length >= MIN_GAPS) {
    const byRoute = gapsByRoute(gaps);
    const { text, chart, alt } = composeGaps(account, byRoute, gaps.length, win.label);
    let image = null;
    try {
      image = { data: await renderBarChart(chart), alt };
    } catch (err) {
      log(`recaps: gap chart failed: ${err.message}`);
    }
    await poster.post({
      account,
      kind: 'recap-gaps',
      subject,
      text,
      ...(image && { image }),
      ...(parent && { reply: parent.uri }),
    });
    result.gaps = gaps.length;
  }
  return result.hotspots || result.gaps ? { posted: period, ...result } : { skipped: 'quiet' };
}
