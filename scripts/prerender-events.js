// Prerender per-event HTML stubs and OG images so social media crawlers
// (Bluesky, Mastodon, Slack, iMessage, etc.) get event-specific cards. Crawlers
// don't run JS; they just read meta tags from whatever HTML the URL serves.
// This script emits `dist/event/<id>/index.html` (clone of the SPA shell with
// rewritten OG meta) plus `dist/event/<id>/og.jpg` (1200x630,
// Playwright-rendered).
//
// Only the incidents eventScope.js selects (active + recent) get a stub.
//
// Runs as a postbuild step. Requires `dist/data/alerts.json` to be present —
// it's copied from `public/data/` by Vite at build time.

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
import { breadcrumbJsonLd, eventTrail } from '../src/lib/breadcrumbs.js';
import { formatDate, formatTime } from '../src/lib/format.js';
import {
  formatRoutesLabel,
  groupIncidentRecords,
  incidentRecords,
  observationSignals,
  summarizeSignals,
} from '../src/lib/incidents.js';
import { METRO_LINES, normalizeMetroLine } from '../src/lib/metroLines.js';
import { normalizeRailLine, RAIL_LINES } from '../src/lib/railLines.js';
import { SITE_NAME, SITE_ORIGIN } from '../src/lib/site.js';
import { launchChromium } from './browser.js';
import { recentIncidents } from './eventScope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const DATA = resolve(DIST, 'data', 'alerts.json');
const SHELL = resolve(DIST, 'index.html');
const TEMPLATE = resolve(__dirname, 'og-event-template.html');
// Image cache survives across builds via actions/cache. Only the PNG and its
// signature live here — the HTML stub is regenerated every build because it
// embeds the freshly hashed asset paths from `dist/index.html`.
const CACHE = resolve(ROOT, '.og-cache');
const CONCURRENCY = Number(process.env.PRERENDER_CONCURRENCY ?? 6);

const SITE = SITE_ORIGIN;
const SITE_HOST = new URL(SITE_ORIGIN).host;
const BUS_ACCENT = { color: '#475569', soft: 'rgba(71, 85, 105, 0.18)', text: '#fff' };

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function softColor(hex, alpha = 0.18) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(148, 163, 184, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function accentFor(incident) {
  // Multi-route alerts use a kind-based label (e.g. `Routes 17, 33, and 48` or
  // `B1, B2, and B3`) so the OG card reflects the full footprint, not just the
  // first listed route.
  const routes =
    Array.isArray(incident.routes) && incident.routes.length > 0
      ? incident.routes
      : incident.line
        ? [incident.line]
        : [];
  const label = formatRoutesLabel(incident.kind, routes) || 'SEPTA';

  // `chips` renders one pill per affected line/route on the card, mirroring the
  // SPA's LinePill — an L1+B3 incident shows a blue chip *and* an orange chip
  // rather than one chip miscolored as the first line. `label` is still the
  // combined text used for meta tags / JSON-LD; the chips are the visual.
  if (incident.kind === 'metro') {
    const chips = routes.map((r) => {
      const line = METRO_LINES[normalizeMetroLine(r)];
      return line
        ? { color: line.color, text: line.textColor, label: line.label }
        : { color: BUS_ACCENT.color, text: BUS_ACCENT.text, label: r };
    });
    // The left bar + background tint stay a single accent (the first line) —
    // a gradient across N brand colors reads as noise at card size.
    const first = METRO_LINES[normalizeMetroLine(routes[0] ?? '')];
    if (first) {
      return {
        color: first.color,
        soft: softColor(first.color, 0.22),
        text: first.textColor,
        label,
        chips: chips.length > 0 ? chips : [{ ...stripSoft(BUS_ACCENT), label }],
      };
    }
    return {
      ...BUS_ACCENT,
      label,
      chips: chips.length > 0 ? chips : [{ ...stripSoft(BUS_ACCENT), label }],
    };
  }
  // Regional Rail — same chip-per-line treatment as Metro, keyed off RAIL_LINES
  // (lowercase keys). A through-routed train late on two lines carries both.
  if (incident.kind === 'rail') {
    const chips = routes.map((r) => {
      const line = RAIL_LINES[normalizeRailLine(r)];
      return line
        ? { color: line.color, text: line.textColor, label: `${line.label} Line` }
        : { color: BUS_ACCENT.color, text: BUS_ACCENT.text, label: r };
    });
    const first = RAIL_LINES[normalizeRailLine(routes[0] ?? '')];
    if (first) {
      return {
        color: first.color,
        soft: softColor(first.color, 0.22),
        text: first.textColor,
        label,
        chips: chips.length > 0 ? chips : [{ ...stripSoft(BUS_ACCENT), label }],
      };
    }
    return {
      ...BUS_ACCENT,
      label,
      chips: chips.length > 0 ? chips : [{ ...stripSoft(BUS_ACCENT), label }],
    };
  }
  // Bus alerts keep a single neutral chip — multi-route bus labels already
  // collapse to bare ids (`Routes 17, 33, and 48`), which there's no brand
  // color to split by.
  return { ...BUS_ACCENT, label, chips: [{ ...stripSoft(BUS_ACCENT), label }] };
}

// Drop the `soft` key from an accent so it can be reused as a chip descriptor
// ({ color, text, label }) without leaking the background-tint field.
function stripSoft({ color, text }) {
  return { color, text };
}

function describeObservation(obs) {
  // Rider-facing impact phrase ("fewer trains and long gaps"), matching the
  // app's incident titles, rather than a detector-name list.
  const summary = summarizeSignals(observationSignals(obs), obs.kind);
  if (!summary) return 'Service disruption detected by bot.';
  const impact = `${summary[0].toLowerCase()}${summary.slice(1)}`;
  // Buses run on a "route", Metro and Regional Rail on a "line". Skip the suffix
  // entirely when the phrase already names the route (thin-gap → "route not
  // running"), so it doesn't read "route not running on this route".
  const where = obs.kind === 'bus' ? ' on this route' : ' on this line';
  const tail = /\broute\b/.test(impact) ? '' : where;
  return `Bot detected ${impact}${tail}.`;
}

// When the incident first occurred, for the OG card — matches the event
// page's "First seen" line ("May 14, 2024 · 4:43 PM", Philadelphia time) so a
// shared card reads the same as the page it links to, and a months-old
// incident no longer looks like it's happening right now. Uses the same
// start instant as the JSON-LD `startDate`.
function formatCardDate(incident) {
  const ts = incident.first_seen_ts ?? incident.ts ?? null;
  if (ts == null) return null;
  return `${formatDate(ts)} · ${formatTime(ts)}`;
}

// Headline for a bot-detected incident. On the card it pairs with the line as
// `${BOT_IMPACT} · ${label}` (the line is also a chip); in the link/meta title
// it leads with the line as `${label} · ${BOT_IMPACT}` so the line isn't
// repeated. Kept as one const so the two orderings can't drift apart.
const BOT_IMPACT = 'Disruption detected';

// Rider-facing impact for a bot-only incident with a collector sentence
// ("Long gaps", "Cancelled bus trips"), or null to fall back to BOT_IMPACT.
function botImpact(incident) {
  if (incident.headline || !incident.bot_description) return null;
  return summarizeSignals(
    observationSignals(incident),
    incident.kind,
    incident.line ?? incident.routes?.[0] ?? null,
  );
}

function summarize(incident) {
  if (incident.headline) {
    return {
      title: incident.headline,
      subtitle: `SEPTA service alert · archived on ${SITE_HOST}`,
    };
  }
  // Regional Rail point event: name the train, and use the collector's
  // pre-rendered sentence ("~22 min late — the 6:31 PM Wawa to Doylestown
  // train (#3556)") as the subtitle.
  const status = { delay: 'delayed', cancellation: 'cancelled' }[incident.detection_source];
  if (incident.kind === 'rail' && status && incident.train_number) {
    return {
      title: `Train #${incident.train_number} ${status}`,
      subtitle: incident.bot_description ?? describeObservation(incident),
    };
  }
  const accent = accentFor(incident);
  // Bus and Metro detections carry the collector's sentence ("~38 min between
  // Route 17 buses …"): lead with the impact and let the sentence explain.
  const impact = botImpact(incident);
  if (impact) return { title: `${impact} · ${accent.label}`, subtitle: incident.bot_description };
  return {
    title: `${BOT_IMPACT} · ${accent.label}`,
    subtitle: describeObservation(incident),
  };
}

function pickIncidents(payload) {
  // Mirror what the SPA shows: merged + standalone, keyed by the incident id
  // (`_incidentId`, stamped by incidentRecords) so a merged incident doesn't
  // also produce a stub for its underlying alert.
  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    payload.officialRecords ?? [],
    payload.detectionRecords ?? [],
  );
  const out = new Map();
  const add = (incident) => {
    const id = incident._incidentId;
    if (!id || out.has(id)) return;
    out.set(id, incident);
  };
  merged.forEach(add);
  standaloneAlerts.forEach(add);
  standaloneObs.forEach(add);
  return out;
}

// Build a schema.org Event JSON-LD payload for crawler / search consumption.
// schema.org has no perfect "service disruption" type, but Event matches
// the start/end/name shape and is recognized by Google's rich-results
// pipeline. Returned as a string ready to embed in <script>.
function buildJsonLd(incident, { ogTitle, desc, url }) {
  const startTs = incident.first_seen_ts ?? incident.ts ?? null;
  const endTs = incident.resolved_ts ?? null;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    '@id': url,
    name: ogTitle,
    description: desc,
    url,
    eventStatus:
      endTs != null ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    isAccessibleForFree: true,
  };
  if (startTs != null) ld.startDate = new Date(startTs).toISOString();
  if (endTs != null) ld.endDate = new Date(endTs).toISOString();
  // Use the incident's segment endpoints as a place name when available.
  // Schema.org Event.location accepts a Place; we attach a name only since
  // we don't carry geo coordinates per station.
  const fromStation = incident.from_station ?? incident.affected_from_station ?? null;
  const toStation = incident.to_station ?? incident.affected_to_station ?? null;
  const locationName =
    fromStation && toStation ? `${fromStation} → ${toStation}` : (fromStation ?? toStation ?? null);
  if (locationName) {
    ld.location = {
      '@type': 'Place',
      name: locationName,
      address: { '@type': 'PostalAddress', addressLocality: 'Philadelphia', addressRegion: 'PA' },
    };
  } else {
    ld.location = {
      '@type': 'Place',
      name: incident.kind === 'rail' ? 'SEPTA Regional Rail' : 'SEPTA',
      address: { '@type': 'PostalAddress', addressLocality: 'Philadelphia', addressRegion: 'PA' },
    };
  }
  ld.organizer = {
    '@type': 'Organization',
    name: `${SITE_NAME} (unofficial)`,
    url: SITE,
  };
  return JSON.stringify(ld);
}

function buildHtmlStub(shell, { id, title, subtitle, accent, incident }) {
  const url = `${SITE}/event/${id}`;
  // og.jpg is served alongside index.html in the same directory.
  const image = `${url}/og.jpg`;
  // Link/unfurl title leads with the line/route. For bot events the card title
  // ends with the line (it's also a chip), so build the meta title from the bare
  // impact to avoid repeating it ("L1 · Disruption detected"). Alert titles
  // keep the label prefix — a bare headline like "Detour: Construction"
  // otherwise names no route.
  const impact = botImpact(incident);
  const ogTitle = (
    impact
      ? `${accent.label} · ${impact}`
      : incident.headline || title !== `${BOT_IMPACT} · ${accent.label}`
        ? `${accent.label} · ${title}`
        : `${accent.label} · ${BOT_IMPACT}`
  ).slice(0, 200);
  const desc = subtitle.slice(0, 280);
  // Inject JSON-LD just before </head>. `<` inside the JSON has to be escaped
  // because </script> in a string literal would otherwise close the tag.
  const jsonLd = buildJsonLd(incident, { ogTitle, desc, url }).replaceAll('<', '\\u003c');
  // BreadcrumbList trail (Home › day › this incident) — mirrors the visible
  // trail the page renders via lib/breadcrumbs, so structured data and UI agree.
  const trail = eventTrail(incident.first_seen_ts ?? incident.ts ?? null, accent.label);
  const breadcrumbLd = JSON.stringify(breadcrumbJsonLd(trail, SITE)).replaceAll('<', '\\u003c');
  const ldTag =
    `<script type="application/ld+json">${jsonLd}</script>` +
    `\n    <script type="application/ld+json">${breadcrumbLd}</script>`;
  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(ogTitle)} — ${SITE_NAME}</title>`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escAttr(url)}" />`)
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
      `<meta property="og:url" content="${escAttr(url)}" />`,
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
    .replace('</head>', `${ldTag}\n  </head>`);
}

function fillTemplate(tpl, fields) {
  // One pill per affected line/route. Colors are inlined per chip so each
  // carries its own brand color (the template's `--accent` only drives the
  // bar + tint). Falls back to the combined label if chips are somehow absent.
  const chips = fields.accent.chips ?? [
    { color: fields.accent.color, text: fields.accent.text, label: fields.accent.label },
  ];
  const chipsHtml = chips
    .map(
      (c) =>
        `<div class="badge line" style="background: ${c.color}; color: ${c.text};">${escHtml(c.label)}</div>`,
    )
    .join('\n        ');
  // Date — pinned top-right (see .date-corner). Omitted entirely when the
  // incident carries no usable timestamp, so nothing renders rather than an
  // empty element.
  const dateHtml = fields.date ? `<div class="date-corner">${escHtml(fields.date)}</div>` : '';
  return tpl
    .replaceAll('__ACCENT__', fields.accent.color)
    .replaceAll('__ACCENT_SOFT__', fields.accent.soft)
    .replaceAll('__ACCENT_TEXT__', fields.accent.text)
    .replaceAll('__LINE_CHIPS__', chipsHtml)
    .replaceAll('__DATE__', dateHtml)
    .replaceAll('__BADGE__', fields.badge)
    .replaceAll('__TITLE__', escHtml(fields.title))
    .replaceAll('__SUBTITLE__', escHtml(fields.subtitle))
    .replaceAll('__EVENT_ID__', escHtml(fields.id));
}

// Hash the inputs that affect the rendered PNG. If this is unchanged from the
// last build's signature, we can skip Playwright entirely for this event.
function signatureFor({ id, title, subtitle, badge, date, accent, templateHash }) {
  const h = createHash('sha256');
  h.update(JSON.stringify({ id, title, subtitle, badge, date, accent, templateHash }));
  return h.digest('hex');
}

// The card template, with its footer-URL placeholder filled in.
function readEventTemplate() {
  return readFileSync(TEMPLATE, 'utf8').replaceAll('__SITE_HOST__', SITE_HOST);
}

async function renderPng(page, html, outPath) {
  await page.setContent(html, { waitUntil: 'load' });
  // JPEG (not PNG): the per-event cards are gradient+text, and at thousands of
  // events the PNGs (~440KB each) would push the Pages artifact toward its 1GB
  // limit. JPEG q82 is ~6x smaller with no visible loss on these cards.
  await page.screenshot({
    path: outPath,
    type: 'jpeg',
    quality: 82,
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
    console.warn(`prerender-events: ${DATA} missing — skipping (build copies public/data first)`);
    return;
  }
  // Flatten the nested `incidents[]` wire shape into the flat
  // `{ alerts, observations }` the merge/label helpers below expect.
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  raw.incidents = recentIncidents(raw.incidents);
  const payload = { ...raw, ...incidentRecords(raw.incidents || []) };
  const shell = readFileSync(SHELL, 'utf8');
  const template = readEventTemplate();
  const templateHash = createHash('sha256').update(template).digest('hex').slice(0, 16);

  const incidents = pickIncidents(payload);
  if (incidents.size === 0) {
    console.log('prerender-events: no incidents to prerender');
    return;
  }

  mkdirSync(CACHE, { recursive: true });

  // Plan each event: always emit the HTML stub at /event/:id; queue a PNG render
  // only on a signature miss. The badge tracks `incident.active`, so a card
  // re-renders once when its incident resolves.
  const renders = [];
  const seenIds = new Set();
  for (const [id, incident] of incidents) {
    seenIds.add(id);
    const accent = accentFor(incident);
    const { title, subtitle } = summarize(incident);
    const date = formatCardDate(incident);
    const badge = incident.active ? 'Active' : 'Archived';
    const sig = signatureFor({ id, title, subtitle, badge, date, accent, templateHash });
    const outDir = resolve(DIST, 'event', id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, 'index.html'),
      buildHtmlStub(shell, { id, title, subtitle, accent, incident }),
    );
    const cacheDir = resolve(CACHE, id);
    const cachedPng = resolve(cacheDir, 'og.jpg');
    const cachedSig = resolve(cacheDir, 'sig');
    const cached =
      existsSync(cachedPng) && existsSync(cachedSig) && readFileSync(cachedSig, 'utf8') === sig;
    if (cached) {
      copyFileSync(cachedPng, resolve(outDir, 'og.jpg'));
    } else {
      renders.push({
        id,
        html: fillTemplate(template, { id, title, subtitle, badge, date, accent }),
        outDir,
        cacheDir,
        cachedPng,
        cachedSig,
        sig,
      });
    }
  }

  let rendered = 0;

  if (renders.length > 0) {
    const browser = await launchChromium();
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });

    const pages = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, renders.length) }, () => ctx.newPage()),
    );
    let i = 0;
    await workerPool(renders, pages.length, async (item) => {
      const page = pages[i++ % pages.length];
      const out = resolve(item.outDir, 'og.jpg');
      await renderPng(page, item.html, out);
      mkdirSync(item.cacheDir, { recursive: true });
      copyFileSync(out, item.cachedPng);
      writeFileSync(item.cachedSig, item.sig);
      rendered++;
    });

    await browser.close();
  }

  // Sweep cache entries for events no longer in the payload so the cache
  // doesn't grow unboundedly. (Resolved incidents eventually age out of
  // alerts.json; their cached PNGs are no longer reachable.)
  let pruned = 0;
  for (const entry of readdirSync(CACHE)) {
    if (!seenIds.has(entry)) {
      rmSync(resolve(CACHE, entry), { recursive: true, force: true });
      pruned++;
    }
  }

  console.log(
    `prerender-events: ${incidents.size} events · ${rendered} rendered · ${pruned} pruned (concurrency=${CONCURRENCY})`,
  );
}

// Render helpers are exported so debugging/render-og.js can produce a single
// sample card through the exact production path (same accent, summary, template
// fill, and screenshot) instead of a drifting re-implementation. `main()` only
// runs when this file is invoked directly (the postbuild step), not on import.
export {
  accentFor,
  fillTemplate,
  formatCardDate,
  pickIncidents,
  readEventTemplate,
  renderPng,
  summarize,
};

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
