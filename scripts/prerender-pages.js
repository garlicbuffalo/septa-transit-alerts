// Prerender per-page HTML stubs and OG images for /line/:id, /route/:id,
// /station/:slug, /calendar, and /stats so social media crawlers get
// page-specific cards instead of the generic homepage one. Same pattern as
// prerender-events.js: emit an HTML stub at <route>/index.html with
// rewritten OG meta, plus og.png next to it. PNGs are signature-cached so
// unchanged pages skip Playwright.
//
// Scope (intentionally bounded — generating 150+ bus routes when only a few
// are ever shared would be wasteful):
//   - All 13 SEPTA Metro lines + all 13 Regional Rail lines (stable sets,
//     always rendered)
//   - Bus routes that appear in alerts/observations within the 90-day window
//   - Stations from buildStationIndex (already filtered to >=1 incident)
//   - /calendar (singleton, always rendered)
//   - /stats (singleton, always rendered)
//   - /compare (singleton, always rendered)
//   - /system/metro, /system/buses, and /system/rail (singletons, always rendered)
//   - /stations and /routes (A–Z directory indexes, singletons)
//
// Anything outside the scope falls back to the generic homepage OG card,
// which the SPA shell at the unknown route serves by default.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeekSummary, computeStatsLeaderboards, listWeeks } from '../src/lib/aggregate.js';
import { breadcrumbJsonLd, dayTrail, topLevelTrail, weekTrail } from '../src/lib/breadcrumbs.js';
import { BUS_ROUTE_NAMES, busRouteDisplayId, compareBusRoutes } from '../src/lib/busRoutes.js';
import { buildCalendarMonths, maxCountAcrossMonths } from '../src/lib/calendar.js';
import {
  formatDuration,
  formatPhillyDay,
  formatWeekRange,
  phillyDayIsoUTC,
  phillyDayUTC,
} from '../src/lib/format.js';
import { formatRoutesLabel, groupIncidentRecords, incidentRecords } from '../src/lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES, metroLineFullName } from '../src/lib/metroLines.js';
import metroStations from '../src/lib/metroStations.json' with { type: 'json' };
import { RAIL_LINE_ORDER, RAIL_LINES, railLineFullName } from '../src/lib/railLines.js';
import { buildRailStationIndex } from '../src/lib/railStations.js';
import railStations from '../src/lib/railStations.json' with { type: 'json' };
import { SITE_NAME, SITE_ORIGIN } from '../src/lib/site.js';
import { buildStationIndex } from '../src/lib/stations.js';
import { launchChromium } from './browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const DATA = resolve(DIST, 'data', 'alerts.json');
const DAILY_DATA = resolve(DIST, 'data', 'daily-counts.json');
const SHELL = resolve(DIST, 'index.html');
const LINE_TPL = resolve(__dirname, 'og-line-template.html');
const STATION_TPL = resolve(__dirname, 'og-station-template.html');
const CALENDAR_TPL = resolve(__dirname, 'og-calendar-template.html');
const STATS_TPL = resolve(__dirname, 'og-stats-template.html');
const COMPARE_TPL = resolve(__dirname, 'og-compare-template.html');
const ACCESSIBILITY_TPL = resolve(__dirname, 'og-accessibility-template.html');
const DAY_TPL = resolve(__dirname, 'og-day-template.html');
const WEEK_TPL = resolve(__dirname, 'og-week-template.html');
const SYSTEM_TPL = resolve(__dirname, 'og-system-template.html');
const INDEX_TPL = resolve(__dirname, 'og-index-template.html');
const CACHE = resolve(ROOT, '.og-cache-pages');
const CONCURRENCY = Number(process.env.PRERENDER_CONCURRENCY ?? 6);

const SITE = SITE_ORIGIN;
const SITE_HOST = new URL(SITE_ORIGIN).host;
const BUS_ACCENT = { color: '#475569', soft: 'rgba(71, 85, 105, 0.18)', text: '#fff' };

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

// Templates carry a `__SITE_HOST__` placeholder for the footer URL.
function readTemplate(path) {
  return readFileSync(path, 'utf8').replaceAll('__SITE_HOST__', SITE_HOST);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function softColor(hex, alpha = 0.18) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(148, 163, 184, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Mirrors CalendarPage's cellBg — five intensity stops keyed off max. Kept
// inline here (not imported) because the page consumes it as a CSS variable;
// here we want a literal color string for HTML style attributes.
function calendarCellColor(count, maxCount) {
  if (count === 0 || maxCount <= 0) return '#e2e8f0';
  const ratio = count / maxCount;
  if (ratio < 0.2) return 'rgba(100, 116, 139, 0.25)';
  if (ratio < 0.4) return 'rgba(100, 116, 139, 0.45)';
  if (ratio < 0.7) return 'rgba(100, 116, 139, 0.65)';
  if (ratio < 0.9) return 'rgba(100, 116, 139, 0.85)';
  return 'rgb(71, 85, 105)';
}

// Render the 12-month grid as HTML the OG template can drop in. Uses the
// same buildCalendarMonths logic the live page uses, so the share image
// shows the actual data — busy days dark, sparse months mostly empty.
function buildCalendarGridHtml(dailyPayload) {
  const months = buildCalendarMonths(dailyPayload?.days ?? [], {
    monthsBack: 12,
    dataStartTs: dailyPayload?.data_start_ts ?? null,
  });
  const maxCount = maxCountAcrossMonths(months);
  const labelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  });
  const rows = months.map((m) => {
    const label = labelFmt.format(new Date(Date.UTC(m.year, m.month - 1, 1)));
    const cells = m.cells
      .map((cell) => {
        if (cell.placeholder || cell.future) return '<div class="cell future"></div>';
        if (cell.noData) return '<div class="cell no-data"></div>';
        const bg = calendarCellColor(cell.count, maxCount);
        return `<div class="cell" style="background:${bg}"></div>`;
      })
      .join('');
    return `<div class="month-row"><div class="month-label">${escHtml(label)}</div>${cells}</div>`;
  });
  return rows.join('');
}

// Render the four-stat leaderboard as HTML for the OG card. Mirrors the
// shape of StatsPage but flattened to two label/value rows per cell.
const STATS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function statsHour(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function buildStatsHtml(leaders) {
  const items = [];
  if (leaders.worstDay) {
    items.push({
      label: 'Worst day',
      value: `${formatPhillyDay(leaders.worstDay.dayUtc)} · ${leaders.worstDay.count} incident${leaders.worstDay.count === 1 ? '' : 's'}`,
    });
  } else {
    items.push({ label: 'Worst day', value: 'Not enough data yet' });
  }
  if (leaders.worstHour) {
    items.push({
      label: 'Worst hour',
      value: `${STATS_DAYS[leaders.worstHour.weekday]} ${statsHour(leaders.worstHour.hour)} · ${leaders.worstHour.count} incident${leaders.worstHour.count === 1 ? '' : 's'}`,
    });
  } else {
    items.push({ label: 'Worst hour', value: 'Not enough data yet' });
  }
  if (leaders.worstStation) {
    items.push({
      label: 'Most-affected station',
      value: `${leaders.worstStation.name} · ${leaders.worstStation.count} incident${leaders.worstStation.count === 1 ? '' : 's'}`,
    });
  } else {
    items.push({ label: 'Most-affected station', value: 'No station data yet' });
  }
  if (leaders.longestIncident) {
    const routes = formatRoutesLabel(leaders.longestIncident.kind, leaders.longestIncident.routes);
    items.push({
      label: 'Longest incident',
      value: `${routes} · ${formatDuration(leaders.longestIncident.durationMs)}`,
    });
  } else {
    items.push({ label: 'Longest incident', value: 'No resolved incidents yet' });
  }
  return items
    .map(
      (it) =>
        `<div class="stat"><p class="stat-eyebrow">${escHtml(it.label)}</p><p class="stat-value">${escHtml(it.value)}</p></div>`,
    )
    .join('');
}

function statsSubtitle(payload) {
  const total = (payload.officialRecords?.length ?? 0) + (payload.detectionRecords?.length ?? 0);
  if (total === 0) return 'Worst days, hours, stations, and longest incidents on record.';
  return `Worst days, hours, stations, and longest incidents — across ${total} record${total === 1 ? '' : 's'}.`;
}

function calendarSubtitle(dailyPayload) {
  let total = 0;
  for (const d of dailyPayload?.days ?? []) {
    total += (d.metro_count || 0) + (d.bus_count || 0) + (d.rail_count || 0);
  }
  const span = (dailyPayload?.days ?? []).length;
  if (total === 0) return 'Daily incident heatmap';
  return `${total} incident${total === 1 ? '' : 's'} across ${span} day${span === 1 ? '' : 's'}`;
}

// Compute which Metro lines, bus routes, and Regional Rail lines currently have
// an active disruption (alert or observation that hasn't resolved). The OG card
// switches into an "Active disruption" variant for those, so a shared link
// surfaces the in-progress state instead of a stale-looking card.
function activeRoutesByKind(payload) {
  const active = { metro: new Set(), bus: new Set(), rail: new Set() };
  for (const a of payload.officialRecords ?? []) {
    if (!a.active || !active[a.kind]) continue;
    for (const r of a.routes ?? []) active[a.kind].add(String(r));
  }
  for (const o of payload.detectionRecords ?? []) {
    if (!o.active || !o.line || !active[o.kind]) continue;
    active[o.kind].add(String(o.line));
  }
  return active;
}

const busPill = (route) =>
  `<span class="line-pill" style="background:#475569;color:#fff">${escHtml(busRouteDisplayId(route))}</span>`;

// Build the list of line/route/station "pages" to render. Each item carries
// everything the renderer needs: a stable slug for the cache key and output
// path, the raw input fields, and the kind so we pick the right template.
function planPages(payload, dailyPayload) {
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const pages = [];
  const { metro: activeMetro, bus: activeBuses, rail: activeRail } = activeRoutesByKind(payload);

  // Calendar — singleton page. Always rendered so a fresh deploy never
  // ships without its share card. The grid HTML is computed up front and
  // baked into the signature so a content change re-renders the PNG.
  if (dailyPayload) {
    const gridHtml = buildCalendarGridHtml(dailyPayload);
    const subtitle = calendarSubtitle(dailyPayload);
    pages.push({
      kind: 'calendar',
      slug: 'calendar',
      outDir: resolve(DIST, 'calendar'),
      url: `${SITE}/calendar`,
      path: '/calendar',
      ogTitle: `12-Month Calendar · ${SITE_NAME}`,
      desc: `A 12-month heatmap of daily SEPTA service alerts and detected disruptions — archived on ${SITE_HOST}.`,
      subtitle,
      gridHtml,
    });
  }

  // Compare — singleton page. Template is fully static (no per-build data
  // baked into the card); we just emit it so /compare gets its own OG image
  // for social sharing instead of the homepage card. Skipped if the template
  // file is missing (defensive — the template ships with the repo).
  if (existsSync(COMPARE_TPL)) {
    pages.push({
      kind: 'compare',
      slug: 'compare',
      outDir: resolve(DIST, 'compare'),
      url: `${SITE}/compare`,
      path: '/compare',
      ogTitle: `Compare SEPTA lines · ${SITE_NAME}`,
      desc: `Side-by-side reliability and resolution time for up to 3 SEPTA Metro lines, bus routes, or Regional Rail lines — archived on ${SITE_HOST}.`,
      subtitle: '',
    });
  }

  if (existsSync(ACCESSIBILITY_TPL)) {
    pages.push({
      kind: 'accessibility',
      slug: 'accessibility',
      outDir: resolve(DIST, 'accessibility'),
      url: `${SITE}/accessibility`,
      path: '/accessibility',
      ogTitle: `Accessibility · ${SITE_NAME}`,
      desc: `SEPTA Metro and Regional Rail elevator outages and recent station accessibility history — archived on ${SITE_HOST}.`,
      subtitle:
        'SEPTA Metro and Regional Rail elevator outages, archived separately from service disruptions.',
    });
  }

  // System-health pages — one card per mode (Metro / bus / Regional Rail).
  // Metro gets the line-code pills; buses get service-category pills; Regional
  // Rail gets its route codes. All share a single template.
  {
    const metroPills = METRO_LINE_ORDER.map((lineId) => {
      const info = METRO_LINES[lineId];
      if (!info) return '';
      return `<span class="pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.label)}</span>`;
    }).join('');
    // Bus pill set: generic service-type categories rather than specific
    // route numbers. Naming a handful of routes on the card implied those
    // were the only ones covered — they're not; every route with recent
    // activity gets a row on the page. Categories convey the breadth of
    // the bus network without singling anyone out.
    const BUS_CATEGORIES = ['City', 'Suburban', 'Express', 'Owl service'];
    const busPills = BUS_CATEGORIES.map(
      (label) =>
        `<span class="pill" style="background:#475569;color:#fff">${escHtml(label)}</span>`,
    ).join('');
    // Total bus-route count drives the subtitle. Computed across the same
    // 90-day window the page itself uses, so the card's claim matches what
    // a visitor sees when they arrive.
    const busRoutesInWindow = new Set();
    const cutoffNinety = now - WINDOW_DAYS * DAY_MS;
    for (const a of payload.officialRecords ?? []) {
      if (a.kind !== 'bus' || (a.first_seen_ts ?? 0) < cutoffNinety) continue;
      for (const r of a.routes ?? []) busRoutesInWindow.add(String(r));
    }
    for (const o of payload.detectionRecords ?? []) {
      if (o.kind !== 'bus' || !o.line || (o.ts ?? 0) < cutoffNinety) continue;
      busRoutesInWindow.add(String(o.line));
    }
    const totalBusRoutes = busRoutesInWindow.size;

    pages.push({
      kind: 'system',
      mode: 'metro',
      slug: 'system-metro',
      outDir: resolve(DIST, 'system', 'metro'),
      url: `${SITE}/system/metro`,
      path: '/system/metro',
      ogTitle: `SEPTA Metro system health · ${SITE_NAME}`,
      desc: `System-wide health for SEPTA Metro (subway, elevated, trolley, and Norristown lines): active disruptions, per-line incident counts, disruption hours, and 30-day trends — archived on ${SITE_HOST}.`,
      title: 'SEPTA Metro system health',
      subtitle:
        'Every SEPTA Metro line at a glance — active disruptions, recent activity, and 30-day disruption time.',
      pillHtml: metroPills,
      // Metro: a wash of the line colors across the card, plus a vertical
      // multi-stop bar mirroring the same palette.
      bgGradient:
        'linear-gradient(120deg, rgba(0, 151, 214, 0.12) 0%, rgba(242, 97, 0, 0.10) 28%, rgba(95, 36, 159, 0.10) 50%, rgba(90, 150, 10, 0.12) 75%, rgba(220, 46, 107, 0.10) 100%)',
      accentBar:
        'linear-gradient(180deg, #0097D6 0%, #F26100 22%, #5F249F 42%, #5A960A 62%, #FFD700 80%, #DC2E6B 100%)',
    });
    pages.push({
      kind: 'system',
      mode: 'bus',
      slug: 'system-buses',
      outDir: resolve(DIST, 'system', 'buses'),
      url: `${SITE}/system/buses`,
      path: '/system/buses',
      ogTitle: `Bus system health · ${SITE_NAME}`,
      desc: `System-wide health for SEPTA buses: active disruptions, per-route incident counts, disruption hours, and 30-day trends — archived on ${SITE_HOST}.`,
      title: 'Bus system health',
      subtitle:
        totalBusRoutes > 0
          ? `${totalBusRoutes} bus route${totalBusRoutes === 1 ? '' : 's'} with recent activity — active disruptions, incident counts, and 30-day disruption time.`
          : 'Active disruptions, incident counts, and 30-day disruption time for every bus route on record.',
      pillHtml: busPills,
      // Buses share the muted slate identity used for bus pills on the
      // site itself, with a hint of warmth toward the bottom to keep the
      // card from reading as monochrome.
      bgGradient:
        'linear-gradient(135deg, rgba(71, 85, 105, 0.18) 0%, rgba(100, 116, 139, 0.10) 45%, rgba(249, 115, 22, 0.10) 100%)',
      accentBar: 'linear-gradient(180deg, #334155 0%, #64748b 60%, #f97316 100%)',
    });

    // Regional Rail system card — the 13 lines as compact route-code pills
    // (full names overflow). Regional Rail shares one brand color, so the card
    // uses SEPTA's rail slate with a blue/orange wash.
    const railPills = RAIL_LINE_ORDER.map((line) => {
      const info = RAIL_LINES[line];
      if (!info) return '';
      return `<span class="pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.code)}</span>`;
    }).join('');
    pages.push({
      kind: 'system',
      mode: 'rail',
      slug: 'system-rail',
      outDir: resolve(DIST, 'system', 'rail'),
      url: `${SITE}/system/rail`,
      path: '/system/rail',
      ogTitle: `Regional Rail system health · ${SITE_NAME}`,
      desc: `System-wide health for SEPTA Regional Rail: active disruptions, per-line cancellations and delays, and 30-day trends — archived on ${SITE_HOST}.`,
      title: 'Regional Rail system health',
      subtitle:
        'Every Regional Rail line at a glance — active disruptions, cancellations, and delays over the last 30 days.',
      pillHtml: railPills,
      bgGradient:
        'linear-gradient(120deg, rgba(79, 117, 139, 0.16) 0%, rgba(0, 151, 214, 0.10) 50%, rgba(242, 97, 0, 0.08) 100%)',
      accentBar: 'linear-gradient(180deg, #4F758B 0%, #0097D6 60%, #F26100 100%)',
    });
  }

  // Stats / leaderboards — also a singleton. Reuses the same leaderboard
  // function the live page calls so the share image and the page agree.
  const leaders = computeStatsLeaderboards(
    payload.officialRecords ?? [],
    payload.detectionRecords ?? [],
    {
      now,
      windowDays: WINDOW_DAYS,
    },
  );
  const statsHtml = buildStatsHtml(leaders);
  pages.push({
    kind: 'stats',
    slug: 'stats',
    outDir: resolve(DIST, 'stats'),
    url: `${SITE}/stats`,
    path: '/stats',
    ogTitle: `Stats · ${SITE_NAME}`,
    desc: `Worst days, hours, stations, and longest incidents on SEPTA — archived on ${SITE_HOST}.`,
    subtitle: statsSubtitle(payload),
    statsHtml,
  });

  // Directory index pages (/stations, /routes) — singletons backed by the
  // static roster, so they always render. They're the canonical A–Z entry
  // points into every station/line/route page, hence their own share cards
  // rather than the generic homepage one. Pills wash the Metro palette so the
  // card reads as "the whole system".
  const indexMetroPills = METRO_LINE_ORDER.map((lineId) => {
    const info = METRO_LINES[lineId];
    if (!info) return '';
    return `<span class="pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.label)}</span>`;
  }).join('');
  const busRouteCount = Object.keys(BUS_ROUTE_NAMES).length;
  const railStationCount = new Set(
    Object.values(railStations).flatMap((list) => list.map((st) => st.name)),
  ).size;
  pages.push({
    kind: 'index',
    slug: 'stations-index',
    outDir: resolve(DIST, 'stations'),
    url: `${SITE}/stations`,
    path: '/stations',
    title: 'All stations',
    ogTitle: `All stations · ${SITE_NAME}`,
    desc: `A–Z index of SEPTA Metro and Regional Rail stations, each linking to its service-alert and disruption history — archived on ${SITE_HOST}.`,
    subtitle: `Every SEPTA Metro and Regional Rail station, A–Z — ${metroStations.length} Metro stops and ${railStationCount} rail stations, each with its alert history.`,
    pillHtml: indexMetroPills,
  });
  pages.push({
    kind: 'index',
    slug: 'routes-index',
    outDir: resolve(DIST, 'routes'),
    url: `${SITE}/routes`,
    path: '/routes',
    title: 'All routes',
    ogTitle: `All routes · ${SITE_NAME}`,
    desc: `Index of every SEPTA Metro line, bus route, and Regional Rail line, each linking to its service-alert and disruption history — archived on ${SITE_HOST}.`,
    subtitle: `Every SEPTA line and route in one place — ${METRO_LINE_ORDER.length} Metro lines, ${busRouteCount} bus routes, and ${RAIL_LINE_ORDER.length} Regional Rail lines.`,
    pillHtml:
      indexMetroPills +
      ['Bus', 'Regional Rail']
        .map(
          (label) =>
            `<span class="pill" style="background:#475569;color:#fff">${escHtml(label)}</span>`,
        )
        .join(''),
  });

  // SEPTA Metro lines: always all of them — small stable set, deserves full
  // coverage. The pill carries the line code ("L1"); the line name goes in the
  // headline slot.
  for (const lineId of METRO_LINE_ORDER) {
    const info = METRO_LINES[lineId];
    if (!info) continue;
    const active = activeMetro.has(lineId);
    pages.push({
      kind: 'line',
      slug: `line-${lineId}`,
      outDir: resolve(DIST, 'line', lineId),
      url: `${SITE}/line/${lineId}`,
      path: `/line/${lineId}`,
      feedPath: `/feed/line/${lineId}.xml`,
      label: info.label,
      crumbLabel: metroLineFullName(lineId),
      title: info.name,
      ogTitle: `${metroLineFullName(lineId)} · ${SITE_NAME}`,
      desc: `Service alerts and detected disruptions on SEPTA Metro's ${metroLineFullName(lineId)} — archived on ${SITE_HOST}.`,
      subtitle: active
        ? 'Active disruption right now — see live status.'
        : 'Service alerts and disruptions, archived.',
      accent: { color: info.color, soft: softColor(info.color, 0.22), text: info.textColor },
      active,
    });
  }

  // Regional Rail lines — stable set of 13, always rendered. The pill carries
  // SEPTA's three-letter code (PAO) and the full line name goes in the headline
  // slot, since names like "Manayunk/Norristown" are too long for the pill.
  for (const lineId of RAIL_LINE_ORDER) {
    const info = RAIL_LINES[lineId];
    if (!info) continue;
    const active = activeRail.has(lineId);
    pages.push({
      kind: 'line',
      slug: `rail-line-${lineId}`,
      outDir: resolve(DIST, 'rail', 'line', lineId),
      url: `${SITE}/rail/line/${lineId}`,
      path: `/rail/line/${lineId}`,
      feedPath: `/feed/rail/line/${lineId}.xml`,
      label: info.code,
      crumbLabel: railLineFullName(lineId),
      title: railLineFullName(lineId),
      ogTitle: `${railLineFullName(lineId)} · Regional Rail · ${SITE_NAME}`,
      desc: `Cancellations, delays, and service alerts on SEPTA Regional Rail's ${railLineFullName(lineId)} — archived on ${SITE_HOST}.`,
      subtitle: active
        ? 'Active disruption right now — see live status.'
        : 'Cancellations, delays, and service alerts, archived.',
      accent: { color: info.color, soft: softColor(info.color, 0.22), text: info.textColor },
      active,
    });
  }

  // Bus routes with at least one incident in the window. Sorted leading-numeric
  // for deterministic build output (helps caching when nothing's changed).
  const busRoutes = new Set();
  for (const o of payload.detectionRecords || []) {
    if (o.kind === 'bus' && o.line && o.ts >= cutoff) busRoutes.add(o.line);
  }
  for (const a of payload.officialRecords || []) {
    if (a.kind !== 'bus' || a.first_seen_ts < cutoff) continue;
    for (const r of a.routes || []) busRoutes.add(r);
  }
  for (const route of [...busRoutes].map(String).sort(compareBusRoutes)) {
    const name = BUS_ROUTE_NAMES[route];
    const display = busRouteDisplayId(route);
    // Pill stays compact ("17") so it doesn't overflow with long SEPTA route
    // names like "Frankford Transportation Center to Plymouth Meeting Mall".
    // The full name lives in the title slot underneath, where it can wrap
    // and clamp gracefully.
    const ogLabel = name ? `Route ${display} (${name})` : `Route ${display}`;
    const active = activeBuses.has(String(route));
    pages.push({
      kind: 'route',
      slug: `route-${route}`,
      outDir: resolve(DIST, 'route', String(route)),
      url: `${SITE}/route/${route}`,
      path: `/route/${route}`,
      feedPath: `/feed/route/${route}.xml`,
      label: display,
      crumbLabel: `Route ${display}`,
      title: name ?? '',
      ogTitle: `${ogLabel} · ${SITE_NAME}`,
      desc: `Service alerts and detours on SEPTA bus ${ogLabel} — archived on ${SITE_HOST}.`,
      subtitle: active
        ? 'Active disruption right now — see live status.'
        : 'Service alerts and detours, archived.',
      accent: BUS_ACCENT,
      active,
    });
  }

  // Day pages — every Philadelphia calendar day in the rolling window that had at
  // least one incident. Skipped when the merge step yields nothing for that
  // day, so a zero-incident day doesn't claim a share card.
  const DAY_PRERENDER_WINDOW_DAYS = 30;
  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    payload.officialRecords ?? [],
    payload.detectionRecords ?? [],
  );
  const daysWithIncidents = new Map(); // dayUtc → { metroLines, busRoutes, railLines, count }
  function bumpDay(ts, kind, routes) {
    if (ts == null) return;
    const day = phillyDayUTC(ts);
    if (day < phillyDayUTC(now) - (DAY_PRERENDER_WINDOW_DAYS - 1) * DAY_MS) return;
    if (day > phillyDayUTC(now)) return;
    let entry = daysWithIncidents.get(day);
    if (!entry) {
      entry = { metroLines: new Set(), busRoutes: new Set(), railLines: new Set(), count: 0 };
      daysWithIncidents.set(day, entry);
    }
    entry.count += 1;
    for (const r of routes ?? []) {
      if (kind === 'metro') entry.metroLines.add(r);
      else if (kind === 'bus') entry.busRoutes.add(String(r));
      else if (kind === 'rail') entry.railLines.add(r);
    }
  }
  for (const m of merged) bumpDay(m.first_seen_ts, m.kind, m.routes);
  for (const a of standaloneAlerts) bumpDay(a.first_seen_ts, a.kind, a.routes);
  for (const o of standaloneObs) bumpDay(o.first_seen_ts ?? o.ts, o.kind, o.line ? [o.line] : []);

  for (const [dayUtc, entry] of [...daysWithIncidents].sort((a, b) => b[0] - a[0])) {
    const d = new Date(dayUtc);
    const isoDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const pillHtml = [
      ...[...entry.metroLines]
        .map((line) => {
          const info = METRO_LINES[line];
          if (!info) return null;
          return `<span class="line-pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.label)}</span>`;
        })
        .filter(Boolean),
      ...[...entry.busRoutes].sort(compareBusRoutes).slice(0, 8).map(busPill),
      ...[...entry.railLines]
        .map((line) => {
          const info = RAIL_LINES[line];
          if (!info) return null;
          return `<span class="line-pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.code)}</span>`;
        })
        .filter(Boolean)
        .slice(0, 6),
    ].join('');
    const lineCount = entry.metroLines.size + entry.busRoutes.size + entry.railLines.size;
    pages.push({
      kind: 'day',
      slug: `day-${isoDate}`,
      outDir: resolve(DIST, 'day', isoDate),
      url: `${SITE}/day/${isoDate}`,
      path: `/day/${isoDate}`,
      dayUtc,
      ogTitle: `${formatPhillyDay(dayUtc)} · ${SITE_NAME}`,
      desc: `SEPTA service alerts and detected disruptions on ${formatPhillyDay(dayUtc)} — archived on ${SITE_HOST}.`,
      title: formatPhillyDay(dayUtc),
      subtitle: `${entry.count} incident${entry.count === 1 ? '' : 's'} across ${lineCount} line${lineCount === 1 ? '' : 's'}/route${lineCount === 1 ? '' : 's'}`,
      pillHtml,
    });
  }

  // Week pages — the /week archive. One card per Sun–Sat week since data
  // start, plus a /week landing card for the current week. Content comes from
  // buildWeekSummary so the card and the live page agree.
  const weeks = listWeeks({ dataStartTs: payload.data_start_ts ?? null, now });
  function weekPillsHtml(summary) {
    return summary.mostAffected
      .slice(0, 8)
      .map((m) => {
        if (m.kind === 'metro' || m.kind === 'rail') {
          const info = m.kind === 'metro' ? METRO_LINES[m.id] : RAIL_LINES[m.id];
          if (!info) return null;
          const label = m.kind === 'metro' ? info.label : info.code;
          return `<span class="line-pill" style="background:${info.color};color:${info.textColor}">${escHtml(label)}</span>`;
        }
        return busPill(m.id);
      })
      .filter(Boolean)
      .join('');
  }
  for (const weekStartUtc of weeks) {
    const iso = phillyDayIsoUTC(weekStartUtc);
    const range = formatWeekRange(weekStartUtc, { year: true });
    const summary = buildWeekSummary(
      payload.officialRecords ?? [],
      payload.detectionRecords ?? [],
      weekStartUtc,
      now,
    );
    const modeSplit = `${summary.metroCount} Metro, ${summary.busCount} bus, ${summary.railCount} Regional Rail`;
    const subtitle =
      summary.total === 0
        ? 'No incidents started this week'
        : `${summary.total} incident${summary.total === 1 ? '' : 's'} · ${modeSplit}`;
    const desc =
      summary.total === 0
        ? `Service alerts and detected disruptions on SEPTA for the week of ${range} (Sunday–Saturday) — archived on ${SITE_HOST}.`
        : `${summary.total} SEPTA incident${summary.total === 1 ? '' : 's'} during the week of ${range} (Sunday–Saturday) — ${modeSplit}. Archived on ${SITE_HOST}.`;
    const common = {
      kind: 'week',
      weekStartUtc,
      title: `Week of ${range}`,
      subtitle,
      pillHtml: weekPillsHtml(summary),
      ogTitle: `Week of ${range} · ${SITE_NAME}`,
      desc,
    };
    pages.push({
      ...common,
      slug: `week-${iso}`,
      outDir: resolve(DIST, 'week', iso),
      url: `${SITE}/week/${iso}`,
      path: `/week/${iso}`,
    });
    // The most recent week also backs the /week landing page.
    if (weekStartUtc === weeks[0]) {
      pages.push({
        ...common,
        slug: 'week-current',
        outDir: resolve(DIST, 'week'),
        url: `${SITE}/week`,
        path: '/week',
      });
    }
  }

  // Stations from the index (already filtered to >=1 incident in 90d).
  const stationIndex = buildStationIndex(payload.officialRecords, payload.detectionRecords, {
    now,
    windowDays: WINDOW_DAYS,
  });
  for (const [slug, rec] of [...stationIndex].sort((a, b) => a[0].localeCompare(b[0]))) {
    const linePills = rec.lines
      .map((line) => {
        const info = METRO_LINES[line];
        if (!info) return null;
        return `<span class="line-pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.label)}</span>`;
      })
      .filter(Boolean)
      .join('');
    pages.push({
      kind: 'station',
      slug: `station-${slug}`,
      outDir: resolve(DIST, 'station', slug),
      url: `${SITE}/station/${slug}`,
      path: `/station/${slug}`,
      stationName: rec.name,
      linePills,
      ogTitle: `${rec.name} · SEPTA Metro · ${SITE_NAME}`,
      desc: `Service alerts and detected disruptions at ${rec.name} on SEPTA Metro — archived on ${SITE_HOST}.`,
      subtitle: `SEPTA Metro station · ${rec.count} incident${rec.count === 1 ? '' : 's'} on record (90d)`,
    });
  }

  // Regional Rail stations — same card, built from the Regional Rail station
  // index. They live under the /rail/station/ namespace.
  const railStationIndex = buildRailStationIndex(
    payload.officialRecords,
    payload.detectionRecords,
    {
      now,
      windowDays: WINDOW_DAYS,
    },
  );
  for (const [slug, rec] of [...railStationIndex].sort((a, b) => a[0].localeCompare(b[0]))) {
    const linePills = rec.lines
      .map((line) => {
        const info = RAIL_LINES[line];
        if (!info) return null;
        return `<span class="line-pill" style="background:${info.color};color:${info.textColor}">${escHtml(info.code)}</span>`;
      })
      .filter(Boolean)
      .join('');
    pages.push({
      kind: 'station',
      slug: `rail-station-${slug}`,
      outDir: resolve(DIST, 'rail', 'station', slug),
      url: `${SITE}/rail/station/${slug}`,
      path: `/rail/station/${slug}`,
      stationName: rec.name,
      linePills,
      ogTitle: `${rec.name} · Regional Rail · ${SITE_NAME}`,
      desc: `SEPTA Regional Rail cancellations, delays, and service alerts at ${rec.name} — archived on ${SITE_HOST}.`,
      subtitle: `Regional Rail station · ${rec.count} incident${rec.count === 1 ? '' : 's'} on record (90d)`,
    });
  }

  return pages;
}

// Breadcrumb trail for a page kind — mirrors the visible trail each page
// renders via lib/breadcrumbs, so structured data and UI stay in sync.
function trailFor(page) {
  switch (page.kind) {
    case 'day':
      return dayTrail(page.dayUtc);
    case 'week':
      return weekTrail(page.weekStartUtc);
    case 'station':
      return topLevelTrail(page.stationName);
    case 'system':
      return topLevelTrail(page.title);
    case 'calendar':
      return topLevelTrail('Calendar');
    case 'compare':
      return topLevelTrail('Compare');
    case 'accessibility':
      return topLevelTrail('Accessibility');
    case 'stats':
      return topLevelTrail('Stats');
    case 'index':
      return topLevelTrail(page.title);
    case 'line':
    case 'route':
      return topLevelTrail(page.crumbLabel ?? page.label);
    default:
      return null;
  }
}

// JSON-LD <script> tags for a page: a WebPage/CollectionPage node describing
// the page itself (#11) plus a BreadcrumbList trail (#12). Pages that collect
// incidents (line/route/station/day) are CollectionPage; the rest are WebPage.
function structuredDataTags(page, ogTitle, desc) {
  const collection = ['line', 'route', 'station', 'day', 'week', 'index'].includes(page.kind);
  const blocks = [
    {
      '@context': 'https://schema.org',
      '@type': collection ? 'CollectionPage' : 'WebPage',
      '@id': page.url,
      url: page.url,
      name: ogTitle,
      description: desc,
      inLanguage: 'en-US',
      isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website` },
    },
  ];
  const trail = trailFor(page);
  if (trail) blocks.push(breadcrumbJsonLd(trail, SITE));
  return blocks
    .map(
      (b) =>
        `<script type="application/ld+json">${JSON.stringify(b).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('\n    ');
}

function buildHtmlStub(shell, page) {
  const image = `${page.url}/og.png`;
  const ogTitle = page.ogTitle.slice(0, 200);
  const desc = page.desc.slice(0, 280);
  const ldTags = structuredDataTags(page, ogTitle, desc);
  // Feed autodiscovery: line/route pages advertise their per-line/route Atom
  // feed so readers can subscribe straight from the page. Appended after the
  // canonical link (only for pages that carry a feedPath).
  const feedLink = page.feedPath
    ? `\n    <link rel="alternate" type="application/atom+xml" title="${escAttr(ogTitle)}" href="${escAttr(`${SITE}${page.feedPath}`)}" />`
    : '';
  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(ogTitle)}</title>`)
    .replace(
      /<link rel="canonical"[^>]*>/,
      `<link rel="canonical" href="${escAttr(page.url)}" />${feedLink}`,
    )
    .replace(
      /<meta name="description"[^>]*>/,
      `<meta name="description" content="${escAttr(desc)}" />`,
    )
    .replace(
      /<meta property="og:title"[^>]*>/,
      `<meta property="og:title" content="${escAttr(ogTitle)}" />`,
    )
    .replace(
      /<meta property="og:description"[^>]*>/,
      `<meta property="og:description" content="${escAttr(desc)}" />`,
    )
    .replace(
      /<meta property="og:url"[^>]*>/,
      `<meta property="og:url" content="${escAttr(page.url)}" />`,
    )
    .replace(
      /<meta property="og:image"[^>]*>/g,
      `<meta property="og:image" content="${escAttr(image)}" />`,
    )
    .replace(
      /<meta property="og:image:alt"[^>]*>/,
      `<meta property="og:image:alt" content="${escAttr(ogTitle)}" />`,
    )
    .replace(
      /<meta name="twitter:title"[^>]*>/,
      `<meta name="twitter:title" content="${escAttr(ogTitle)}" />`,
    )
    .replace(
      /<meta name="twitter:description"[^>]*>/,
      `<meta name="twitter:description" content="${escAttr(desc)}" />`,
    )
    .replace(
      /<meta name="twitter:image"[^>]*>/g,
      `<meta name="twitter:image" content="${escAttr(image)}" />`,
    )
    .replace(
      /<meta name="twitter:image:alt"[^>]*>/,
      `<meta name="twitter:image:alt" content="${escAttr(ogTitle)}" />`,
    )
    .replace('</head>', `${ldTags}\n  </head>`);
}

const ACTIVE_RIBBON_HTML =
  '<div class="active-ribbon"><span class="dot"></span>Active disruption</div>';

function fillLineTemplate(tpl, page) {
  return tpl
    .replaceAll('__ACCENT__', page.accent.color)
    .replaceAll('__ACCENT_SOFT__', page.accent.soft)
    .replaceAll('__ACCENT_TEXT__', page.accent.text)
    .replaceAll('__LABEL__', escHtml(page.label))
    .replaceAll('__TITLE__', escHtml(page.title ?? ''))
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PATH__', escHtml(page.path))
    .replaceAll('__ACTIVE_RIBBON__', page.active ? ACTIVE_RIBBON_HTML : '');
}

function fillStationTemplate(tpl, page) {
  return tpl
    .replaceAll('__STATION_NAME__', escHtml(page.stationName))
    .replaceAll('__LINE_PILLS__', page.linePills)
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PATH__', escHtml(page.path));
}

function fillCalendarTemplate(tpl, page) {
  return tpl
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__GRID__', page.gridHtml);
}

function fillStatsTemplate(tpl, page) {
  return tpl
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__STATS__', page.statsHtml);
}

// Compare template is static — no placeholders to fill. The function exists
// for symmetry with the others and to give us a hook if we ever want to
// make the card per-combination later.
function fillCompareTemplate(tpl) {
  return tpl;
}

function fillAccessibilityTemplate(tpl, page) {
  return tpl.replaceAll('__SUBTITLE__', escHtml(page.subtitle));
}

function fillSystemTemplate(tpl, page) {
  return tpl
    .replaceAll('__BG_GRADIENT__', page.bgGradient)
    .replaceAll('__ACCENT_BAR__', page.accentBar)
    .replaceAll('__TITLE__', escHtml(page.title))
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PILLS__', page.pillHtml)
    .replaceAll('__PATH__', escHtml(page.path));
}

// Directory-index card shares the system card's TITLE/SUBTITLE/PILLS/PATH
// slots; the gradient and accent bar are baked into the template.
function fillIndexTemplate(tpl, page) {
  return tpl
    .replaceAll('__TITLE__', escHtml(page.title))
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PILLS__', page.pillHtml)
    .replaceAll('__PATH__', escHtml(page.path));
}

function fillDayTemplate(tpl, page) {
  return tpl
    .replaceAll('__TITLE__', escHtml(page.title))
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PILLS__', page.pillHtml)
    .replaceAll('__PATH__', escHtml(page.path));
}

// Week card shares the day card's TITLE/SUBTITLE/PILLS/PATH slots.
function fillWeekTemplate(tpl, page) {
  return tpl
    .replaceAll('__TITLE__', escHtml(page.title))
    .replaceAll('__SUBTITLE__', escHtml(page.subtitle))
    .replaceAll('__PILLS__', page.pillHtml)
    .replaceAll('__PATH__', escHtml(page.path));
}

function signatureFor(page, templateHash) {
  const h = createHash('sha256');
  // Hash the fields that actually affect the rendered PNG; keep the URL out
  // so identical content under a renamed slug would still cache-hit (it
  // won't happen in practice, but principle: PNG content depends on visual
  // fields only).
  let payload;
  if (page.kind === 'station') {
    payload = {
      kind: 'station',
      name: page.stationName,
      pills: page.linePills,
      sub: page.subtitle,
    };
  } else if (page.kind === 'calendar') {
    payload = { kind: 'calendar', sub: page.subtitle, grid: page.gridHtml };
  } else if (page.kind === 'stats') {
    payload = { kind: 'stats', sub: page.subtitle, stats: page.statsHtml };
  } else if (page.kind === 'compare') {
    // Static template — content is fully baked in. The template hash
    // (mixed in below) is the only thing that can change the PNG.
    payload = { kind: 'compare' };
  } else if (page.kind === 'accessibility') {
    payload = { kind: 'accessibility', sub: page.subtitle };
  } else if (page.kind === 'index') {
    payload = { kind: 'index', title: page.title, sub: page.subtitle, pills: page.pillHtml };
  } else if (page.kind === 'day') {
    payload = { kind: 'day', title: page.title, sub: page.subtitle, pills: page.pillHtml };
  } else if (page.kind === 'week') {
    payload = { kind: 'week', title: page.title, sub: page.subtitle, pills: page.pillHtml };
  } else if (page.kind === 'system') {
    payload = {
      kind: 'system',
      mode: page.mode,
      title: page.title,
      sub: page.subtitle,
      pills: page.pillHtml,
      bg: page.bgGradient,
      bar: page.accentBar,
    };
  } else {
    payload = {
      kind: page.kind,
      label: page.label,
      title: page.title ?? '',
      accent: page.accent,
      sub: page.subtitle,
      active: !!page.active,
    };
  }
  h.update(JSON.stringify({ ...payload, templateHash }));
  return h.digest('hex');
}

async function renderPng(page, html, outPath) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({
    path: outPath,
    type: 'png',
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });
}

async function workerPool(items, size, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function main() {
  if (!existsSync(DATA)) {
    console.warn(`prerender-pages: ${DATA} missing — skipping`);
    return;
  }
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  const payload = { ...raw, ...incidentRecords(raw.incidents || []) };
  // daily-counts.json is optional — if it's missing (e.g. during a build
  // before the cron has dropped one in), skip the calendar OG card rather
  // than failing the whole step.
  const dailyPayload = existsSync(DAILY_DATA) ? JSON.parse(readFileSync(DAILY_DATA, 'utf8')) : null;
  const shell = readFileSync(SHELL, 'utf8');
  const lineTpl = readTemplate(LINE_TPL);
  const stationTpl = readTemplate(STATION_TPL);
  const calendarTpl = existsSync(CALENDAR_TPL) ? readTemplate(CALENDAR_TPL) : null;
  const statsTpl = existsSync(STATS_TPL) ? readTemplate(STATS_TPL) : null;
  const compareTpl = existsSync(COMPARE_TPL) ? readTemplate(COMPARE_TPL) : null;
  const accessibilityTpl = existsSync(ACCESSIBILITY_TPL) ? readTemplate(ACCESSIBILITY_TPL) : null;
  // DAY_TPL is required (ships in the repo). Treat like LINE_TPL/STATION_TPL.
  const dayTpl = readTemplate(DAY_TPL);
  const weekTpl = readTemplate(WEEK_TPL);
  const systemTpl = readTemplate(SYSTEM_TPL);
  const indexTpl = readTemplate(INDEX_TPL);
  const lineHash = createHash('sha256').update(lineTpl).digest('hex').slice(0, 16);
  const stationHash = createHash('sha256').update(stationTpl).digest('hex').slice(0, 16);
  const calendarHash = calendarTpl
    ? createHash('sha256').update(calendarTpl).digest('hex').slice(0, 16)
    : '';
  const statsHash = statsTpl
    ? createHash('sha256').update(statsTpl).digest('hex').slice(0, 16)
    : '';
  const compareHash = compareTpl
    ? createHash('sha256').update(compareTpl).digest('hex').slice(0, 16)
    : '';
  const accessibilityHash = accessibilityTpl
    ? createHash('sha256').update(accessibilityTpl).digest('hex').slice(0, 16)
    : '';
  const dayHash = createHash('sha256').update(dayTpl).digest('hex').slice(0, 16);
  const weekHash = createHash('sha256').update(weekTpl).digest('hex').slice(0, 16);
  const systemHash = createHash('sha256').update(systemTpl).digest('hex').slice(0, 16);
  const indexHash = createHash('sha256').update(indexTpl).digest('hex').slice(0, 16);

  const pages = planPages(payload, dailyPayload);
  if (pages.length === 0) {
    console.log('prerender-pages: nothing to render');
    return;
  }

  mkdirSync(CACHE, { recursive: true });

  const renders = [];
  const seenSlugs = new Set();
  for (const page of pages) {
    seenSlugs.add(page.slug);
    let tplHash;
    if (page.kind === 'station') tplHash = stationHash;
    else if (page.kind === 'calendar') tplHash = calendarHash;
    else if (page.kind === 'stats') tplHash = statsHash;
    else if (page.kind === 'compare') tplHash = compareHash;
    else if (page.kind === 'accessibility') tplHash = accessibilityHash;
    else if (page.kind === 'day') tplHash = dayHash;
    else if (page.kind === 'week') tplHash = weekHash;
    else if (page.kind === 'system') tplHash = systemHash;
    else if (page.kind === 'index') tplHash = indexHash;
    else tplHash = lineHash;
    const sig = signatureFor(page, tplHash);

    mkdirSync(page.outDir, { recursive: true });
    writeFileSync(resolve(page.outDir, 'index.html'), buildHtmlStub(shell, page));

    const cacheDir = resolve(CACHE, page.slug);
    const cachedPng = resolve(cacheDir, 'og.png');
    const cachedSig = resolve(cacheDir, 'sig');
    const sigMatches =
      existsSync(cachedPng) && existsSync(cachedSig) && readFileSync(cachedSig, 'utf8') === sig;

    if (sigMatches) {
      copyFileSync(cachedPng, resolve(page.outDir, 'og.png'));
      continue;
    }

    let html;
    if (page.kind === 'station') html = fillStationTemplate(stationTpl, page);
    else if (page.kind === 'calendar') html = fillCalendarTemplate(calendarTpl, page);
    else if (page.kind === 'stats') html = fillStatsTemplate(statsTpl, page);
    else if (page.kind === 'compare') html = fillCompareTemplate(compareTpl);
    else if (page.kind === 'accessibility')
      html = fillAccessibilityTemplate(accessibilityTpl, page);
    else if (page.kind === 'day') html = fillDayTemplate(dayTpl, page);
    else if (page.kind === 'week') html = fillWeekTemplate(weekTpl, page);
    else if (page.kind === 'system') html = fillSystemTemplate(systemTpl, page);
    else if (page.kind === 'index') html = fillIndexTemplate(indexTpl, page);
    else html = fillLineTemplate(lineTpl, page);
    renders.push({ page, html, cacheDir, cachedPng, cachedSig, sig });
  }

  let rendered = 0;
  const cached = pages.length - renders.length;

  if (renders.length > 0) {
    const browser = await launchChromium();
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    const playwrightPages = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, renders.length) }, () => ctx.newPage()),
    );
    let i = 0;
    await workerPool(renders, playwrightPages.length, async (item) => {
      const pw = playwrightPages[i++ % playwrightPages.length];
      const out = resolve(item.page.outDir, 'og.png');
      await renderPng(pw, item.html, out);
      mkdirSync(item.cacheDir, { recursive: true });
      copyFileSync(out, item.cachedPng);
      writeFileSync(item.cachedSig, item.sig);
      rendered++;
    });
    await browser.close();
  }

  // Sweep stale cache entries (e.g. a bus route or station that aged out of
  // the 90-day window since the last build).
  let pruned = 0;
  for (const entry of readdirSync(CACHE)) {
    if (!seenSlugs.has(entry)) {
      rmSync(resolve(CACHE, entry), { recursive: true, force: true });
      pruned++;
    }
  }

  console.log(
    `prerender-pages: ${rendered} rendered, ${cached} cache-hit, ${pruned} pruned (concurrency=${CONCURRENCY})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
