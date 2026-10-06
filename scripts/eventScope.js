// Which incidents get a prerendered /event/:id stub + OG card. Shared by
// prerender-events.js (which renders them), generate-sitemap.js (which lists
// them), and generate-feed.js (which only links a card image that exists).
//
// Active incidents and those first seen in the last PRERENDER_DAYS — enough for
// anything still being shared, without the build growing with the whole
// archive. Older /event/:id links still work through the SPA fallback
// (404.html); they just unfurl with the site-wide card.

const DAY_MS = 24 * 60 * 60 * 1000;
export const PRERENDER_DAYS = 90;

/** True when a v2 incident (or a flat record with first_seen_ts/active) gets a stub. */
export function hasEventStub(incident, now = Date.now()) {
  const active = incident.lifecycle?.active ?? incident.active;
  const firstSeen = incident.lifecycle?.first_seen_ts ?? incident.first_seen_ts ?? incident.ts;
  return Boolean(active) || (firstSeen ?? 0) >= now - PRERENDER_DAYS * DAY_MS;
}

/** Filter v2 incidents to the prerendered set. */
export function recentIncidents(incidents, now = Date.now()) {
  return (incidents || []).filter((inc) => hasEventStub(inc, now));
}
