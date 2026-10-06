#!/usr/bin/env node
// Render a single event's OG card to a PNG so you can eyeball template/title
// changes without a full `npm run build` + postbuild over every event.
//
// It reuses the exact production render path exported from
// scripts/prerender-events.js (accent → summary → fillTemplate → chromium
// screenshot), so the sample card is byte-faithful to what the build emits —
// no drifting re-implementation.
//
// Usage:
//   node debugging/render-og.js --id alert-136615
//   node debugging/render-og.js --id alert-136615 --out tmp/card.jpg
//   node debugging/render-og.js --id alert-136615 --data public/data/alerts-recent.json
//
// Data source: the deployed site's alerts-recent.json by default (DATA_URL
// overrides it); pass --data <path> to render from a local snapshot.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../scripts/browser.js';
import {
  accentFor,
  fillTemplate,
  formatCardDate,
  pickIncidents,
  readEventTemplate,
  renderPng,
  summarize,
} from '../scripts/prerender-events.js';
import { incidentRecords } from '../src/lib/incidents.js';
import { SITE_ORIGIN } from '../src/lib/site.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// The deployed site's recent slice by default; override with DATA_URL.
const LIVE = process.env.DATA_URL || `${SITE_ORIGIN}/data/alerts-recent.json`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

async function loadPayload(dataArg) {
  let raw;
  if (dataArg) {
    raw = JSON.parse(readFileSync(resolve(ROOT, dataArg), 'utf8'));
  } else {
    const res = await fetch(LIVE);
    if (!res.ok) throw new Error(`fetch ${LIVE} → ${res.status}`);
    raw = await res.json();
  }
  return { ...raw, ...incidentRecords(raw.incidents || []) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = args.id;
  if (!id) {
    console.error(
      'Usage: node debugging/render-og.js --id <eventId> [--out <path>] [--data <path>]',
    );
    process.exit(1);
  }
  const out = resolve(ROOT, args.out || `tmp/og-${id}.jpg`);

  const payload = await loadPayload(args.data);
  const incident = pickIncidents(payload).get(id);
  if (!incident) {
    console.error(`No event with id "${id}" in ${args.data ? args.data : LIVE}.`);
    console.error('The id is the last segment of an /event/<id> URL.');
    process.exit(1);
  }

  const accent = accentFor(incident);
  const { title, subtitle } = summarize(incident);
  const date = formatCardDate(incident);
  // Mirrors prerender-events: the badge tracks live state.
  const badge = incident.active ? 'Active' : 'Archived';

  const template = readEventTemplate();
  const html = fillTemplate(template, { id, title, subtitle, badge, date, accent });

  mkdirSync(dirname(out), { recursive: true });
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    await renderPng(page, html, out);
  } finally {
    await browser.close();
  }

  console.log(`Wrote ${out}`);
  console.log(`  title:    ${title}`);
  console.log(`  subtitle: ${subtitle}`);
  console.log(`  badge:    ${badge} · date: ${date ?? '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
