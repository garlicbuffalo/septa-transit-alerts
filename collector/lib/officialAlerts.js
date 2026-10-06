// Official SEPTA alerts → incidents.
//
// SEPTA's v2 alerts feed mixes three kinds of record:
//   ADVISORY  numeric ids — curated service advisories (shuttle busing, station
//             closures, platform changes, Amtrak-related delays)
//   ALERT     real-time service alerts
//   DETOUR    "D"-prefixed ids — bus detours and stop discontinuations, most
//             of them multi-month construction notices
//
// The site tracks disruptions, so the feed is filtered (see classifyAlert):
// long-running detours and station-amenity notices (parking, fare machines,
// waiting rooms) are dropped, and elevator notices are left to the separate
// accessibility archive. Everything else becomes an incident whose lifecycle
// runs from when SEPTA posted it until it leaves the feed (or its stated end
// time passes).
import { groupRoutesByMode } from './network.js';
import { findStationScope } from './stations.js';
import { htmlToText } from './text.js';
import { isEndOfDayClock, isStartOfDayClock, parseEastern } from './time.js';

const HOUR_MS = 60 * 60 * 1000;
// Detours with a stated window longer than this are background construction
// notices, not disruptions.
export const DETOUR_MAX_WINDOW_MS = 72 * HOUR_MS;
// An alert still listed this long after its stated end is treated as over.
const EXPIRED_GRACE_MS = HOUR_MS;

const AMENITY_RE =
  /\b(parking|waiting room|ticket office|fare (sales|products?)|validators?|restrooms?|is now the)\b/i;
const ACCESSIBILITY_RE = /\b(elevators?|escalators?)\b/i;
const NON_SERVICE_EFFECTS = new Set(['NO_EFFECT', 'OTHER_EFFECT']);

/** True for SEPTA's detour records ("D17471" ids or type DETOUR). */
export function isDetour(raw) {
  return /^D\d+$/i.test(String(raw?.alert_id ?? '')) || raw?.type === 'DETOUR';
}

/**
 * Decide whether a raw SEPTA alert becomes an incident.
 * @param {object} raw One record from the v2 alerts feed.
 * @returns {{ include: boolean, reason: string }}
 */
export function classifyAlert(raw) {
  const routes = (raw?.routes || []).filter(Boolean);
  if (routes.length === 0) return { include: false, reason: 'no-routes' };
  if (isDetour(raw)) {
    const start = parseEastern(raw.start);
    const end = parseEastern(raw.end);
    if (start == null || end == null) return { include: false, reason: 'open-ended-detour' };
    if (end - start > DETOUR_MAX_WINDOW_MS) return { include: false, reason: 'long-term-detour' };
    return { include: true, reason: 'short-detour' };
  }
  const subject = String(raw.subject ?? '');
  if (ACCESSIBILITY_RE.test(subject)) return { include: false, reason: 'accessibility' };
  if (AMENITY_RE.test(subject)) return { include: false, reason: 'station-amenity' };
  if (raw.type === 'ADVISORY' && NON_SERVICE_EFFECTS.has(raw.effect)) {
    return { include: false, reason: 'no-service-effect' };
  }
  return { include: true, reason: raw.type === 'ALERT' ? 'alert' : 'advisory' };
}

// SEPTA's schedule page for a route — the closest stable public page to an
// individual alert (alerts have no permalinks of their own).
function routePageUrl(rawRoute) {
  return `https://www.septa.org/schedules/${encodeURIComponent(String(rawRoute).trim())}`;
}

/**
 * Normalize one raw alert into one incident "part" per network it touches. An
 * alert listing both L1 (Metro) and L1 OWL (bus) becomes two incidents, since
 * an incident carries a single mode. The first network keeps the bare id.
 * @param {object} raw
 * @returns {Array<object>}
 */
export function alertParts(raw) {
  const detour = isDetour(raw);
  const baseId = detour
    ? `detour-${String(raw.alert_id).toLowerCase()}`
    : `alert-${String(raw.alert_id).toLowerCase()}`;
  const subject = htmlToText(raw.subject).replace(/\s+/g, ' ').trim();
  const body = htmlToText(raw.message);
  const headline = detour ? `Detour: ${subject || 'route change'}` : subject || body.split('\n')[0];
  const startTs = parseEastern(raw.start);
  const endTs = parseEastern(raw.end);
  const createdTs = parseEastern(raw.created_at);
  return groupRoutesByMode(raw.routes).map(([mode, routes], i) => ({
    id: i === 0 ? baseId : `${baseId}-${mode.replace('_', '-')}`,
    alertId: String(raw.alert_id),
    mode,
    routes,
    headline,
    description: body || null,
    createdTs,
    window: {
      start_ts: startTs,
      end_ts: endTs,
      start_is_date_only: startTs != null && isStartOfDayClock(raw.start),
      end_is_date_only: endTs != null && isEndOfDayClock(raw.end),
    },
    scope: findStationScope(`${subject}\n${body}`, mode, routes),
    septa: {
      type: raw.type ?? null,
      cause: raw.cause ?? null,
      effect: raw.effect ?? null,
      severity: raw.severity ?? null,
    },
    sourceUrl: routePageUrl(raw.routes.find(Boolean)),
  }));
}

function closedLifecycle(firstSeen, resolvedTs) {
  const resolved = Math.max(firstSeen, resolvedTs);
  return {
    first_seen_ts: firstSeen,
    resolved_ts: resolved,
    active: false,
    duration_ms: resolved - firstSeen,
  };
}

function openLifecycle(firstSeen) {
  return { first_seen_ts: firstSeen, resolved_ts: null, active: true, duration_ms: null };
}

// Build the incident for a part, carrying identity, first-seen time, and the
// text-revision history over from the previous version when there is one.
function buildIncident(part, existing, now) {
  const prevAlert = existing?.official_alert ?? null;
  const firstSeen =
    existing?.lifecycle?.first_seen_ts ??
    (part.createdTs != null && part.createdTs <= now ? part.createdTs : now);

  let versions = prevAlert?.versions ?? null;
  const textChanged =
    prevAlert &&
    (prevAlert.headline !== part.headline || (prevAlert.description ?? null) !== part.description);
  if (textChanged) {
    versions = versions ?? [
      {
        ts: prevAlert.lifecycle?.first_seen_ts ?? firstSeen,
        headline: prevAlert.headline,
        short_description: prevAlert.description ?? null,
      },
    ];
    versions = [
      ...versions,
      { ts: now, headline: part.headline, short_description: part.description },
    ];
  }

  const lifecycle = openLifecycle(firstSeen);
  const official = {
    id: part.alertId,
    headline: part.headline,
    description: part.description,
    post_url: null,
    source_url: part.sourceUrl,
    resolved_reply_url: null,
    lifecycle: { ...lifecycle },
    scope: part.scope,
    agency_event_window: part.window,
    septa: part.septa,
  };
  if (versions && versions.length > 1) official.versions = versions;

  return {
    id: part.id,
    agency: 'septa',
    mode: part.mode,
    routes: part.routes,
    sources: ['septa'],
    lifecycle,
    official_alert: official,
    detections: [],
    status: null,
  };
}

function resolveIncident(inc, resolvedTs) {
  const lifecycle = closedLifecycle(inc.lifecycle.first_seen_ts, resolvedTs);
  return {
    ...inc,
    lifecycle,
    official_alert: inc.official_alert
      ? { ...inc.official_alert, lifecycle: { ...lifecycle } }
      : inc.official_alert,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one successful fetch of the alerts feed to the incident map (mutates
 * it). New alerts open incidents, listed ones refresh in place, and active
 * official incidents missing from the feed resolve. Resolution is skipped when
 * the feed looks truncated (under half the currently-active set), so an API
 * hiccup can't mass-close live incidents.
 * @param {Map<string, object>} incidents
 * @param {object[]} rawAlerts
 * @param {number} now
 * @returns {{ changed: Set<string>, stats: object }}
 */
export function applyOfficialAlerts(incidents, rawAlerts, now) {
  const changed = new Set();
  const stats = { feed: 0, included: 0, opened: 0, resolved: 0, skipped: {} };
  const parts = [];
  for (const raw of rawAlerts || []) {
    stats.feed += 1;
    const { include, reason } = classifyAlert(raw);
    if (!include) {
      stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
      continue;
    }
    stats.included += 1;
    parts.push(...alertParts(raw));
  }

  const seen = new Set();
  for (const part of parts) {
    if (seen.has(part.id)) continue;
    seen.add(part.id);
    const existing = incidents.get(part.id) ?? null;
    let next = buildIncident(part, existing, now);
    const end = part.window.end_ts;
    if (end != null && end + EXPIRED_GRACE_MS < now) next = resolveIncident(next, end);
    if (!existing) stats.opened += 1;
    if (!existing || !same(existing, next)) {
      incidents.set(part.id, next);
      changed.add(part.id);
    }
  }

  const activeOfficial = [...incidents.values()].filter(
    (inc) => inc.official_alert && inc.lifecycle?.active,
  );
  const truncated = activeOfficial.length >= 10 && seen.size < activeOfficial.length / 2;
  stats.truncated = truncated;
  if (!truncated) {
    for (const inc of activeOfficial) {
      if (seen.has(inc.id)) continue;
      const end = inc.official_alert.agency_event_window?.end_ts;
      const resolvedAt = end != null && end < now ? end : now;
      incidents.set(inc.id, resolveIncident(inc, resolvedAt));
      changed.add(inc.id);
      stats.resolved += 1;
    }
  }
  return { changed, stats };
}
