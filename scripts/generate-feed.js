// Generate dist/feed.xml — an Atom feed of the 50 most recent incidents
// (alerts + bot observations, merged the same way the UI merges them).
//
// Runs as a postbuild step, after `dist/data/alerts.json` is in place. Data
// changes trigger a repository_dispatch rebuild, and the scheduled Pages build
// is the catch-up net if a dispatch is missed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUS_ROUTE_NAMES,
  busRouteDisplayId,
  compareBusRoutes,
  formatBusRoute,
} from '../src/lib/busRoutes.js';
import { formatDuration, formatEstimatedEnd } from '../src/lib/format.js';
import {
  formatEvidenceChip,
  formatRoutesLabel,
  groupIncidentRecords,
  incidentRecords,
  observationSignals,
  SIGNAL_LABELS,
  summarizeSignals,
} from '../src/lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES, metroLineFullName } from '../src/lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES, railLineFullName } from '../src/lib/railLines.js';
import { SITE_NAME, SITE_ORIGIN } from '../src/lib/site.js';
import { hasEventStub } from './eventScope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = resolve(ROOT, 'dist', 'data', 'alerts.json');
const OUT_ATOM = resolve(ROOT, 'dist', 'feed.xml');
const OUT_JSON = resolve(ROOT, 'dist', 'feed.json');

const SITE = SITE_ORIGIN;
// Tag URI authority (RFC 4151): the site's host plus a pinned date. The 2026
// is not a "current year" — changing it (or the host) alters every entry/feed
// <id> and re-marks every subscriber's read entries as unread, so set the
// final SITE_URL before people subscribe.
const TAG_AUTHORITY = `tag:${new URL(SITE_ORIGIN).host},2026`;
const ENTRY_LIMIT = 50;
// Skip standalone observation-only incidents that resolved within this window
// — almost always a transient detector hiccup (single missed snapshot, etc.)
// rather than a real outage worth pushing to subscribers. Anything backed by
// a SEPTA alert is surfaced regardless of duration; an alert that came and
// went in 2 minutes is itself signal.
const FP_FILTER_MS = 5 * 60 * 1000;

function escapeXml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// An incident's update timestamp — what Atom <updated> should reflect. Drives
// re-surfacing in readers when an ongoing incident meaningfully changes state.
// We deliberately ignore `last_seen_ts`: for an active alert the upstream
// pipeline stamps it to the snapshot time, which would mark every active
// incident unread on every deploy. Resolution is the only state change worth
// re-surfacing for; otherwise the entry's start time is its updated time.
export function updatedTs(incident) {
  return incident.resolved_ts || incident._sortTs || incident.first_seen_ts || incident.ts;
}

function startTs(incident) {
  return incident._sortTs || incident.first_seen_ts || incident.ts;
}

function routesFor(incident) {
  if (Array.isArray(incident.routes)) return incident.routes;
  if (incident.line) return [incident.line];
  return [];
}

// The incident id — stable for the life of the incident, and what the SPA
// routes /event/:id by. Records built by incidentRecords carry it as
// `_incidentId`; hand-built records (tests) fall back to their own id.
function incidentId(incident) {
  return incident._incidentId ?? incident.alert_id ?? incident.id ?? null;
}

export function entryId(incident) {
  return `${TAG_AUTHORITY}:event/${incidentId(incident)}`;
}

function entryLink(incident) {
  const id = incidentId(incident);
  return id ? `${SITE}/event/${encodeURIComponent(id)}` : SITE;
}

// Cache-bust the OG image per-state. Readers and CDNs cache by URL, so without
// `?v=...` an incident that transitioned ongoing→resolved keeps showing the
// stale "ongoing" thumbnail. Keying on updatedTs flips the URL exactly when
// the state changes (entry's <updated> bumps too), so each state caches once.
// Only incidents inside the prerender window have a card to point at.
function entryThumbnail(incident, updatedTs, now = Date.now()) {
  const id = incidentId(incident);
  if (!id || !hasEventStub(incident, now)) return null;
  const base = `${SITE}/event/${encodeURIComponent(id)}/og.jpg`;
  return updatedTs ? `${base}?v=${updatedTs}` : base;
}

// SEPTA's own page for the affected route (alerts have no permalinks).
function sourceUrl(incident) {
  return incident.source_url ?? null;
}

function describeObservation(obs) {
  const stations = [obs.from_station, obs.to_station].filter(Boolean).join(' → ');
  // Rider-facing impact phrase ("fewer trains and long gaps") rather than a
  // detector-name list, matching the app's incident titles.
  const summary = summarizeSignals(observationSignals(obs), obs.kind);
  if (stations && summary) return `${stations} — ${summary[0].toLowerCase()}${summary.slice(1)}`;
  if (stations) return stations;
  if (summary) return summary;
  if (obs.detection_source === 'roundup') return 'Multiple simultaneous disruptions detected';
  return 'Service disruption detected';
}

// True when the headline already names this incident's route — in which case
// prepending the routes label produces awkward duplication ("Route 17: Route
// 17 Detour…", "L1 Market-Frankford Line: L1 Service…").
function headlineNamesRoute(headline, kind, routes) {
  if (!headline || !routes || routes.length === 0) return false;
  const lower = headline.toLowerCase();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasToken = (token) =>
    new RegExp(`(^|[^a-z0-9])${escapeRe(token.toLowerCase())}([^a-z0-9]|$)`).test(lower);
  if (kind === 'bus') {
    // Match the "Route 17" form, not a bare number, to avoid stray hits like
    // "17" inside a date or address.
    return hasToken(`route ${busRouteDisplayId(routes[0])}`);
  }
  if (kind === 'metro') {
    // Any line's code ("L1") or name ("Market-Frankford") identifies it.
    return routes.some((r) => {
      const info = METRO_LINES[r];
      return info && (hasToken(info.label) || hasToken(info.name));
    });
  }
  if (kind === 'rail') {
    return routes.some((r) => {
      const info = RAIL_LINES[r];
      return info && hasToken(info.label);
    });
  }
  return false;
}

function entryTitle(incident) {
  const kind = incident.kind;
  const routes = routesFor(incident);
  const routesLabel = formatRoutesLabel(kind, routes);
  if (incident.headline) {
    if (headlineNamesRoute(incident.headline, kind, routes)) return incident.headline;
    return `${routesLabel}: ${incident.headline}`;
  }
  return `${routesLabel}: ${describeObservation(incident)}`;
}

// Friendly direction labels. Detections may encode direction as
// `branch-0-outbound` / `branch-1-inbound`, plus a synthetic `branch-len…`
// form for full-line outages — that one is meaningless to a reader, so
// suppress it. Alerts arrive as compass words or `'all'`; we map compass to
// `Northbound`/etc.
const COMPASS_LABELS = {
  north: 'Northbound',
  south: 'Southbound',
  east: 'Eastbound',
  west: 'Westbound',
  in: 'Inbound',
  out: 'Outbound',
};
function directionLabel(dir) {
  if (!dir) return null;
  if (dir === 'all') return null;
  if (dir.startsWith('branch-len')) return null;
  if (dir.endsWith('-outbound')) return 'Outbound';
  if (dir.endsWith('-inbound')) return 'Inbound';
  return COMPASS_LABELS[dir] ?? null;
}

function entrySummary(incident) {
  if (incident.headline) {
    const stations = [incident.from_station, incident.to_station].filter(Boolean).join(' → ');
    return stations ? `${incident.headline} (${stations})` : incident.headline;
  }
  return describeObservation(incident);
}

// Build a small HTML body for the entry's <content type="html">. Aimed at
// feed-reader preview panes that render real markup — gives readers a
// scannable card with state, segment, headline, and bot-evidence chip,
// rather than the one-line <summary> they'd otherwise show.
//
// Lead with an <img> when a thumbnail URL exists. Inoreader (and most other
// readers — Feedly, The Old Reader, NetNewsWire) extract the first <img>
// from the content as the entry thumbnail. media:thumbnail / media:content
// declarations alone are inconsistently honored, but the first inline image
// works everywhere.
function entryContentHtml(incident, thumb) {
  const start = startTs(incident);
  const resolved = incident.resolved_ts ?? null;
  // For still-ongoing incidents, append SEPTA's posted end time ("estimated
  // end") when present and meaningfully in the future. Skipped on resolved
  // entries: the actual resolution time is more useful than a stale
  // estimate at that point.
  const estimatedEndText = !resolved
    ? formatEstimatedEnd(incident.agency_event_end_ts, undefined, {
        dateOnly: incident.agency_event_end_is_date_only === true,
      })
    : null;
  const stateLine = resolved
    ? `<strong>Resolved</strong> after ${escapeXml(formatDuration(resolved - start) ?? '')}`
    : incident.active
      ? estimatedEndText
        ? `<strong>Ongoing</strong> · SEPTA estimated end ${escapeXml(estimatedEndText)}`
        : '<strong>Ongoing</strong>'
      : '';
  const stations = [incident.from_station, incident.to_station].filter(Boolean).join(' → ');
  const chip = formatEvidenceChip(incident);
  const headline = incident.headline ? escapeXml(incident.headline) : null;
  const fallback = headline ? null : escapeXml(describeObservation(incident));
  const routesLabel = formatRoutesLabel(incident.kind, routesFor(incident));
  const direction = directionLabel(incident.direction ?? incident.affected_direction);
  const source = sourceUrl(incident);

  const parts = [];
  if (thumb) {
    const altText = headline || fallback || 'Service disruption';
    parts.push(`<p><img src="${escapeXml(thumb)}" alt="${altText}"/></p>`);
  }
  if (stateLine) parts.push(`<p>${stateLine}</p>`);
  if (headline) parts.push(`<p>${headline}</p>`);
  if (fallback) parts.push(`<p>${fallback}</p>`);
  if (stations) parts.push(`<p><em>${escapeXml(stations)}</em></p>`);
  // Routes/direction line — show even when the headline already names the
  // route, so subscribers reading just the preview always see the affected
  // service at a glance.
  const meta = [routesLabel, direction].filter(Boolean).join(' · ');
  if (meta) parts.push(`<p>${escapeXml(meta)}</p>`);
  if (chip) parts.push(`<p>${escapeXml(chip)}</p>`);
  if (source) {
    parts.push(`<p><a href="${escapeXml(source)}">Route page on SEPTA.org →</a></p>`);
  }
  return parts.join('');
}

// Atom <category>/JSON tags. Built as a list of {term, label} pairs:
//   - mode: metro | bus | rail
//   - per-route: line-l1 (L1 Market-Frankford Line), route-17 (Route 17),
//     rail-line-pao (Paoli/Thorndale Line)
//   - state: ongoing | resolved
//   - source: official-alert and/or any signal kinds (pulse-cold, ghost, …)
// Atom uses term + optional label; JSON Feed gets the labels.
function entryCategories(incident) {
  const cats = [];
  const kind = incident.kind;
  const MODE_LABELS = { metro: 'SEPTA Metro', bus: 'Bus', rail: 'Regional Rail' };
  if (MODE_LABELS[kind]) cats.push({ term: kind, label: MODE_LABELS[kind] });
  const routes = routesFor(incident);
  if (kind === 'metro') {
    for (const r of routes) {
      cats.push({ term: `line-${r}`, label: METRO_LINES[r] ? metroLineFullName(r) : r });
    }
  } else if (kind === 'bus') {
    for (const r of routes) cats.push({ term: `route-${r}`, label: formatBusRoute(r) });
  } else if (kind === 'rail') {
    for (const r of routes) {
      cats.push({ term: `rail-line-${r}`, label: RAIL_LINES[r] ? railLineFullName(r) : r });
    }
  }
  cats.push(
    incident.resolved_ts
      ? { term: 'resolved', label: 'Resolved' }
      : incident.active
        ? { term: 'ongoing', label: 'Ongoing' }
        : { term: 'closed', label: 'Closed' },
  );
  // Sources: an alert-backed incident gets `official-alert`; observation signals
  // (pulse-cold, ghost, bunching, …) come from observationSignals which
  // already handles roundup unwrapping.
  if (incident.alert_id || incident.headline) {
    cats.push({ term: 'official-alert', label: 'Official Alert' });
  }
  // Merged records expose detection_source as obs_detection_source — pass a
  // shim so observationSignals' single-key probe finds it. Standalone obs
  // already match the key directly.
  const obsLike = incident.obs_detection_source
    ? { detection_source: incident.obs_detection_source, signals: incident.obs_signals }
    : incident;
  for (const sig of observationSignals(obsLike)) {
    cats.push({ term: sig, label: SIGNAL_LABELS[sig] ?? sig });
  }
  return cats;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

// Filter out standalone observations that resolved within FP_FILTER_MS — they
// almost always represent a transient detector hiccup (single missed
// snapshot, a pulse that flips back inside the same minute) rather than a
// real outage worth a push notification. Anything backed by a SEPTA alert
// (merged or standalone alert) passes regardless of duration.
export function isLikelyDetectorBlip(incident) {
  if (incident.alert_id || incident.headline) return false; // alert-backed
  // Regional Rail cancellations/delays are point-in-time records (resolved_ts ==
  // first_seen_ts), not detector flicker — the zero "duration" is by design, so
  // the duration-based blip filter must not drop them.
  if (incident.kind === 'rail') return false;
  if (!incident.resolved_ts) return false;
  const start = startTs(incident);
  if (!start) return false;
  return incident.resolved_ts - start < FP_FILTER_MS;
}

// `now` decides whether the incident still has a prerendered OG card to use as
// the entry thumbnail (see eventScope.js).
export function buildEntryRecord(incident, { now = Date.now() } = {}) {
  const id = entryId(incident);
  const link = entryLink(incident);
  const title = entryTitle(incident);
  const summary = entrySummary(incident);
  const publishedMs = startTs(incident);
  const updatedMs = updatedTs(incident);
  const thumb = entryThumbnail(incident, updatedMs, now);
  const contentHtml = entryContentHtml(incident, thumb);
  const categories = entryCategories(incident);
  const source = sourceUrl(incident);
  return {
    id,
    link,
    title,
    summary,
    publishedMs,
    updatedMs,
    thumb,
    contentHtml,
    categories,
    sourceUrl: source,
  };
}

export function emitAtom(records, feedUpdatedIso, meta) {
  const entries = records
    .map((r) => {
      const lines = [
        '  <entry>',
        `    <id>${escapeXml(r.id)}</id>`,
        `    <title>${escapeXml(r.title)}</title>`,
        `    <link rel="alternate" type="text/html" href="${escapeXml(r.link)}"/>`,
        `    <published>${toIso(r.publishedMs)}</published>`,
        `    <updated>${toIso(r.updatedMs)}</updated>`,
        `    <summary>${escapeXml(r.summary)}</summary>`,
        // <content type="html"> needs the inner markup escaped so the parser
        // sees it as XML text — readers (Inoreader, Feedly, etc.) un-escape
        // and render the resulting HTML in their preview pane.
        `    <content type="html">${escapeXml(r.contentHtml)}</content>`,
      ];
      for (const c of r.categories) {
        lines.push(
          c.label
            ? `    <category term="${escapeXml(c.term)}" label="${escapeXml(c.label)}"/>`
            : `    <category term="${escapeXml(c.term)}"/>`,
        );
      }
      if (r.thumb) {
        lines.push(
          `    <media:thumbnail url="${escapeXml(r.thumb)}"/>`,
          `    <media:content url="${escapeXml(r.thumb)}" medium="image" type="image/jpeg"/>`,
        );
      }
      lines.push('  </entry>');
      return lines.join('\n');
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>${escapeXml(meta.id)}</id>
  <title>${escapeXml(meta.title)}</title>
  <subtitle>${escapeXml(meta.subtitle)}</subtitle>
  <link rel="alternate" type="text/html" href="${escapeXml(meta.homeUrl)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeXml(meta.selfXml)}"/>
  <link rel="alternate" type="application/feed+json" href="${escapeXml(meta.selfJson)}"/>
  <updated>${feedUpdatedIso}</updated>
  <author><name>${escapeXml(SITE_NAME)}</name></author>
${entries}
</feed>
`;
}

function emitJsonFeed(records, meta) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: meta.title,
    description: meta.subtitle,
    home_page_url: meta.homeUrl,
    feed_url: meta.selfJson,
    language: 'en-US',
    authors: [{ name: SITE_NAME }],
    items: records.map((r) => ({
      id: r.id,
      url: r.link,
      external_url: r.sourceUrl ?? undefined,
      title: r.title,
      summary: r.summary,
      content_html: r.contentHtml,
      image: r.thumb ?? undefined,
      banner_image: r.thumb ?? undefined,
      date_published: toIso(r.publishedMs),
      date_modified: toIso(r.updatedMs),
      tags: r.categories.map((c) => c.label || c.term),
    })),
  };
}

// Feed-level metadata for a given scope. `idPath`/`selfBase` are appended to
// the tag authority and site root respectively, so the global feed and every
// per-line/route feed carry a stable, distinct <id> and self link.
export function feedMeta({ idPath, title, subtitle, homePath, selfBase }) {
  return {
    id: `${TAG_AUTHORITY}:${idPath}`,
    title,
    subtitle,
    homeUrl: `${SITE}${homePath}`,
    selfXml: `${SITE}${selfBase}.xml`,
    selfJson: `${SITE}${selfBase}.json`,
  };
}

// Write one feed's Atom + JSON pair, creating the parent directory as needed
// (the per-line/route feeds live under dist/feed/{line,route}/).
function writeFeed(records, meta, feedUpdatedIso, xmlPath, jsonPath) {
  mkdirSync(dirname(xmlPath), { recursive: true });
  writeFileSync(xmlPath, emitAtom(records, feedUpdatedIso, meta));
  writeFileSync(jsonPath, `${JSON.stringify(emitJsonFeed(records, meta), null, 2)}\n`);
}

// Most-recent-first slice of `pool` scoped to one route, capped at ENTRY_LIMIT.
// `pool` is already sorted newest-first, so the slice preserves that order.
export function scopedRecords(pool, kind, route, { now = Date.now() } = {}) {
  return pool
    .filter((i) => i.kind === kind && routesFor(i).includes(route))
    .slice(0, ENTRY_LIMIT)
    .map((i) => buildEntryRecord(i, { now }));
}

function main() {
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  const payload = { ...raw, ...incidentRecords(raw.incidents || []) };
  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    payload.officialRecords || [],
    payload.detectionRecords || [],
  );

  let dropped = 0;
  // Full candidate set (newest first), not yet capped — each scoped feed takes
  // its own most-recent ENTRY_LIMIT from this pool.
  const pool = [...merged, ...standaloneAlerts, ...standaloneObs]
    .filter((i) => startTs(i))
    .filter((i) => {
      if (isLikelyDetectorBlip(i)) {
        dropped++;
        return false;
      }
      return true;
    })
    .sort((a, b) => updatedTs(b) - updatedTs(a));

  const feedUpdated = pool.length
    ? toIso(updatedTs(pool[0]))
    : toIso(payload.generated_at || Date.now());
  // Per-scope <updated>: the newest entry in that scope (records are
  // newest-first), falling back to the global timestamp for an empty scope.
  const isoUpdated = (records) => (records.length ? toIso(records[0].updatedMs) : feedUpdated);

  // Global feed — unchanged URLs and <id>, so existing subscribers are
  // unaffected by the per-line additions below.
  const globalRecords = pool.slice(0, ENTRY_LIMIT).map((i) => buildEntryRecord(i));
  writeFeed(
    globalRecords,
    feedMeta({
      idPath: 'feed',
      title: SITE_NAME,
      subtitle:
        'SEPTA service alerts and detected disruptions — SEPTA Metro, buses, and Regional Rail.',
      homePath: '/',
      selfBase: '/feed',
    }),
    feedUpdated,
    OUT_ATOM,
    OUT_JSON,
  );

  // One feed per SEPTA Metro line and one per bus route in SEPTA's roster —
  // every line/route is subscribable up front, so a rider can follow
  // their route today and just get a quiet feed until something happens,
  // rather than waiting for a first incident to bring the feed into existence.
  let lineFeeds = 0;
  for (const line of METRO_LINE_ORDER) {
    const records = scopedRecords(pool, 'metro', line);
    const label = metroLineFullName(line);
    writeFeed(
      records,
      feedMeta({
        idPath: `feed/line/${line}`,
        title: `${SITE_NAME} · ${label}`,
        subtitle: `SEPTA service alerts and detected disruptions on the ${label}.`,
        homePath: `/line/${line}`,
        selfBase: `/feed/line/${line}`,
      }),
      isoUpdated(records),
      resolve(ROOT, 'dist', 'feed', 'line', `${line}.xml`),
      resolve(ROOT, 'dist', 'feed', 'line', `${line}.json`),
    );
    lineFeeds++;
  }

  let routeFeeds = 0;
  for (const route of Object.keys(BUS_ROUTE_NAMES).sort(compareBusRoutes)) {
    const records = scopedRecords(pool, 'bus', route);
    const name = BUS_ROUTE_NAMES[route];
    const label = name ? `${formatBusRoute(route)} (${name})` : formatBusRoute(route);
    writeFeed(
      records,
      feedMeta({
        idPath: `feed/route/${route}`,
        title: `${SITE_NAME} · ${label}`,
        subtitle: `SEPTA service alerts and detours on bus ${label}.`,
        homePath: `/route/${route}`,
        selfBase: `/feed/route/${route}`,
      }),
      isoUpdated(records),
      resolve(ROOT, 'dist', 'feed', 'route', `${route}.xml`),
      resolve(ROOT, 'dist', 'feed', 'route', `${route}.json`),
    );
    routeFeeds++;
  }

  // One feed per Regional Rail line, under /feed/rail/line/{key} so it never
  // collides with the Metro /feed/line/{key} namespace. Same proactive-coverage
  // rationale as the Metro and bus feeds.
  let railFeeds = 0;
  for (const line of RAIL_LINE_ORDER) {
    const records = scopedRecords(pool, 'rail', line);
    const label = railLineFullName(line);
    writeFeed(
      records,
      feedMeta({
        idPath: `feed/rail/line/${line}`,
        title: `${SITE_NAME} · Regional Rail ${label}`,
        subtitle: `SEPTA Regional Rail service alerts, cancellations, and delays on the ${label}.`,
        homePath: `/rail/line/${line}`,
        selfBase: `/feed/rail/line/${line}`,
      }),
      isoUpdated(records),
      resolve(ROOT, 'dist', 'feed', 'rail', 'line', `${line}.xml`),
      resolve(ROOT, 'dist', 'feed', 'rail', 'line', `${line}.json`),
    );
    railFeeds++;
  }

  const droppedNote = dropped > 0 ? ` (${dropped} short-lived obs skipped)` : '';
  console.log(
    `generate-feed: wrote ${globalRecords.length} entries to feed.xml + feed.json, ` +
      `plus ${lineFeeds} Metro line + ${routeFeeds} bus route + ${railFeeds} Regional Rail feeds${droppedNote}`,
  );
}

// Run only when invoked directly (`node scripts/generate-feed.js`), not when
// imported by tests — the pure builders below are exported for unit testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
