// Generate dist/sitemap.xml from the same payload the prerender steps use.
// Mirrors prerender-pages.js's scope so the sitemap only lists URLs that
// actually have prerendered HTML stubs and OG cards (i.e. pages that won't
// 404 for crawlers and look intentional when shared).
//
// Runs as a postbuild step after `dist/data/alerts.json` is in place.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWeeks } from '../src/lib/aggregate.js';
import { compareBusRoutes } from '../src/lib/busRoutes.js';
import { phillyDayIsoUTC, phillyDayUTC } from '../src/lib/format.js';
import { groupIncidentRecords, incidentRecords } from '../src/lib/incidents.js';
import { METRO_LINE_ORDER } from '../src/lib/metroLines.js';
import { RAIL_LINE_ORDER } from '../src/lib/railLines.js';
import { buildRailStationIndex } from '../src/lib/railStations.js';
import { SITE_ORIGIN } from '../src/lib/site.js';
import { buildStationIndex } from '../src/lib/stations.js';
import { recentIncidents } from './eventScope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const DATA = resolve(DIST, 'data', 'alerts.json');
const OUT = resolve(DIST, 'sitemap.xml');

const SITE = SITE_ORIGIN;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

function escXml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function isoDate(ms) {
  return new Date(ms).toISOString();
}

function urlEntry(loc, lastmod, changefreq, priority) {
  const parts = [`    <loc>${escXml(loc)}</loc>`];
  if (lastmod) parts.push(`    <lastmod>${escXml(lastmod)}</lastmod>`);
  if (changefreq) parts.push(`    <changefreq>${escXml(changefreq)}</changefreq>`);
  if (priority != null) parts.push(`    <priority>${priority.toFixed(1)}</priority>`);
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

function main() {
  if (!existsSync(DATA)) {
    console.warn(`generate-sitemap: ${DATA} missing — skipping`);
    return;
  }
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  const payload = { ...raw, ...incidentRecords(raw.incidents || []) };
  const generatedAt = payload.generated_at ?? Date.now();
  const generatedIso = isoDate(generatedAt);
  const cutoff = generatedAt - WINDOW_DAYS * DAY_MS;

  const entries = [];

  // Homepage — highest priority, ticks with every data refresh.
  entries.push(urlEntry(`${SITE}/`, generatedIso, 'hourly', 1.0));

  // Singletons.
  entries.push(urlEntry(`${SITE}/calendar`, generatedIso, 'daily', 0.7));
  entries.push(urlEntry(`${SITE}/stats`, generatedIso, 'daily', 0.7));
  entries.push(urlEntry(`${SITE}/compare`, generatedIso, 'monthly', 0.5));
  entries.push(urlEntry(`${SITE}/accessibility`, generatedIso, 'daily', 0.7));
  entries.push(urlEntry(`${SITE}/system/metro`, generatedIso, 'daily', 0.7));
  entries.push(urlEntry(`${SITE}/system/buses`, generatedIso, 'daily', 0.7));
  entries.push(urlEntry(`${SITE}/system/rail`, generatedIso, 'daily', 0.7));

  // A–Z directory index pages — full station/route rosters. Static content
  // (the roster rarely changes), but they're the canonical entry points into
  // every line/route/station page, so give them a notch above the utility pages.
  entries.push(urlEntry(`${SITE}/stations`, generatedIso, 'monthly', 0.6));
  entries.push(urlEntry(`${SITE}/routes`, generatedIso, 'monthly', 0.6));
  entries.push(urlEntry(`${SITE}/map`, generatedIso, 'monthly', 0.6));

  // Static utility pages — prerendered by prerender-static.js so they return
  // 200 with self-referential canonicals. Low priority, rarely change.
  entries.push(urlEntry(`${SITE}/about`, generatedIso, 'monthly', 0.3));
  entries.push(urlEntry(`${SITE}/subscribe`, generatedIso, 'monthly', 0.3));
  entries.push(urlEntry(`${SITE}/privacy`, generatedIso, 'yearly', 0.2));

  // SEPTA Metro lines — stable set of 13.
  for (const line of METRO_LINE_ORDER) {
    entries.push(urlEntry(`${SITE}/line/${line}`, generatedIso, 'daily', 0.7));
  }

  // Regional Rail lines — stable set of 13 (roster pages, prerendered as static stubs).
  for (const line of RAIL_LINE_ORDER) {
    entries.push(urlEntry(`${SITE}/rail/line/${line}`, generatedIso, 'daily', 0.7));
  }

  // Bus routes with at least one incident in the rolling window. Same scope
  // prerender-pages.js uses, so the sitemap and the OG-card set agree.
  const busRoutes = new Set();
  for (const o of payload.detectionRecords || []) {
    if (o.kind === 'bus' && o.line && o.ts >= cutoff) busRoutes.add(o.line);
  }
  for (const a of payload.officialRecords || []) {
    if (a.kind !== 'bus' || a.first_seen_ts < cutoff) continue;
    for (const r of a.routes || []) busRoutes.add(r);
  }
  for (const route of [...busRoutes].map(String).sort(compareBusRoutes)) {
    entries.push(urlEntry(`${SITE}/route/${route}`, generatedIso, 'weekly', 0.5));
  }

  // Stations — already gated by buildStationIndex to those with ≥1 incident.
  const stations = buildStationIndex(
    payload.officialRecords ?? [],
    payload.detectionRecords ?? [],
    {
      now: generatedAt,
      windowDays: WINDOW_DAYS,
    },
  );
  for (const slug of [...stations.keys()].sort()) {
    entries.push(urlEntry(`${SITE}/station/${slug}`, generatedIso, 'weekly', 0.5));
  }

  // Regional Rail stations — same ≥1-incident gating, under /rail/station/.
  const railStations = buildRailStationIndex(
    payload.officialRecords ?? [],
    payload.detectionRecords ?? [],
    {
      now: generatedAt,
      windowDays: WINDOW_DAYS,
    },
  );
  for (const slug of [...railStations.keys()].sort()) {
    entries.push(urlEntry(`${SITE}/rail/station/${slug}`, generatedIso, 'weekly', 0.5));
  }

  // Day pages — every Philadelphia calendar day in the last 30 days that had at
  // least one incident. Same gating as prerender-pages.js so the sitemap and
  // OG cards agree.
  const DAY_WINDOW_DAYS = 30;
  const todayUtc = phillyDayUTC(generatedAt);
  const dayCutoff = todayUtc - (DAY_WINDOW_DAYS - 1) * DAY_MS;
  const daysWithIncidents = new Set();
  function offerDay(ts) {
    if (ts == null) return;
    const d = phillyDayUTC(ts);
    if (d >= dayCutoff && d <= todayUtc) daysWithIncidents.add(d);
  }
  const {
    merged: dayMerged,
    standaloneAlerts: dayStandaloneAlerts,
    standaloneObs: dayStandaloneObs,
  } = groupIncidentRecords(payload.officialRecords ?? [], payload.detectionRecords ?? []);
  for (const m of dayMerged) offerDay(m.first_seen_ts);
  for (const a of dayStandaloneAlerts) offerDay(a.first_seen_ts);
  for (const o of dayStandaloneObs) offerDay(o.first_seen_ts ?? o.ts);
  for (const dayUtc of [...daysWithIncidents].sort((a, b) => b - a)) {
    const d = new Date(dayUtc);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    entries.push(urlEntry(`${SITE}/day/${iso}`, generatedIso, 'weekly', 0.5));
  }

  // Week archive — /week (current-week landing) plus a dated permalink per
  // Sun–Sat week since data_start. Same set prerender-weeks.js emits. Past
  // weeks are stable (lastmod = the following Sunday, after the week closed);
  // the current week ticks with the data.
  const weeks = listWeeks({ dataStartTs: payload.data_start_ts ?? null, now: generatedAt });
  if (weeks.length > 0) {
    entries.push(urlEntry(`${SITE}/week`, generatedIso, 'daily', 0.6));
    for (const weekStartUtc of weeks) {
      const isCurrent = weekStartUtc === weeks[0];
      const lastmod = isCurrent ? generatedIso : isoDate(weekStartUtc + 7 * DAY_MS);
      entries.push(
        urlEntry(
          `${SITE}/week/${phillyDayIsoUTC(weekStartUtc)}`,
          lastmod,
          isCurrent ? 'daily' : 'weekly',
          isCurrent ? 0.6 : 0.4,
        ),
      );
    }
  }

  // Per-event pages — the same set prerender-events.js stubs (active incidents
  // plus everything first seen in its window). lastmod uses resolved_ts when
  // available, else the start time — same semantic as the Atom feed. Crawlers
  // use lastmod to decide whether to revisit, and resolved events don't change.
  const eventEntries = [];
  for (const inc of recentIncidents(raw.incidents || [], generatedAt)) {
    const lastTs = inc.lifecycle?.resolved_ts ?? inc.lifecycle?.first_seen_ts ?? generatedAt;
    eventEntries.push(
      urlEntry(`${SITE}/event/${encodeURIComponent(inc.id)}`, isoDate(lastTs), 'monthly', 0.4),
    );
  }
  entries.push(...eventEntries);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;

  writeFileSync(OUT, xml);
  console.log(`generate-sitemap: wrote ${entries.length} URLs to ${OUT}`);
}

main();
