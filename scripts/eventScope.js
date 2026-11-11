// Which incidents get a prerendered /event/:id stub, and which of those get a
// share card of their own. Shared by prerender-events.js (which renders them),
// generate-sitemap.js (which lists them), and generate-feed.js (which only
// links a card image that exists).
//
// Every stub and card is a file in the published site, and the detectors open
// thousands of incidents a week, so what gets one is by how likely its link is
// to be shared (each card is about 50 KB, each stub about 10; in November 2026,
// five weeks in, a card and two stubs for every incident had the site at 2.1 GB
// against GitHub Pages' 1 GB):
//
//   an official SEPTA alert   stub and card for ALERT_DAYS, and a /resolved
//                             stub (what the bots' "cleared" replies link to)
//   a detection the bots      stub and card for POSTED_DAYS: its post links
//   posted about              to it, and that link is what gets passed on
//   a detection never posted  stub for QUIET_DAYS, with the site's own card
//
// An active incident always has its stub. Older /event/:id links still work
// through the SPA fallback (404.html); they just unfurl with the site-wide card.

const DAY_MS = 24 * 60 * 60 * 1000;
export const ALERT_DAYS = 60;
export const POSTED_DAYS = 21;
export const QUIET_DAYS = 7;
// The longest window, for callers that only want an outer bound.
export const PRERENDER_DAYS = ALERT_DAYS;

/**
 * 'alert' for an incident with an official SEPTA alert, 'posted' for a detection
 * the bots posted about (or listed in a roundup), 'quiet' for the rest.
 * @param {object} incident a published incident (wire shape)
 */
export function eventTier(incident) {
  if (incident.official_alert || incident.official_alerts?.length) return 'alert';
  if ((incident.detections ?? []).some((d) => d.post_url)) return 'posted';
  return 'quiet';
}

const WINDOW_DAYS = { alert: ALERT_DAYS, posted: POSTED_DAYS, quiet: QUIET_DAYS };

/** True when a published incident gets a stub. */
export function hasEventStub(incident, now = Date.now()) {
  const active = incident.lifecycle?.active ?? incident.active;
  const firstSeen = incident.lifecycle?.first_seen_ts ?? incident.first_seen_ts ?? incident.ts;
  return Boolean(active) || (firstSeen ?? 0) >= now - WINDOW_DAYS[eventTier(incident)] * DAY_MS;
}

/** True when a published incident gets a share card of its own. */
export function hasEventCard(incident, now = Date.now()) {
  return eventTier(incident) !== 'quiet' && hasEventStub(incident, now);
}

/** True when a published incident gets a /resolved stub: a finished official alert. */
export function hasResolvedStub(incident, now = Date.now()) {
  const active = incident.lifecycle?.active ?? incident.active;
  return !active && eventTier(incident) === 'alert' && hasEventStub(incident, now);
}

/** Filter published incidents to the prerendered set. */
export function recentIncidents(incidents, now = Date.now()) {
  return (incidents || []).filter((inc) => hasEventStub(inc, now));
}

/** The ids of the incidents with a card of their own. */
export function cardIds(incidents, now = Date.now()) {
  return new Set((incidents || []).filter((inc) => hasEventCard(inc, now)).map((inc) => inc.id));
}
