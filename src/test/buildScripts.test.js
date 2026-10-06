import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickIncidents } from '../../scripts/prerender-events.js';
import * as incidentsLib from '../lib/incidents.js';
import { incidentRecords } from '../lib/incidents.js';
import { incident, officialAlertFromAgency } from './v2TestHelpers.js';

// Regression guard for a class of bug that shipped to production once already:
// the incidents[] migration deleted `normalizeAlertsPayload` from
// src/lib/incidents.js, but five postbuild scripts (prerender-events,
// prerender-pages, generate-feed, generate-sitemap, generate-csv) still
// imported it. ESM named imports of a missing export throw at module load, so
// `npm run build`'s postbuild step crashed and no /event/<rkey> stubs shipped —
// every bot-posted archive link 404'd. CI's PR gate runs `npm test`/`npm run
// lint` but never `npm run build`, so nothing caught it before merge.
//
// These tests assert the contract those scripts depend on: every name they
// import from incidents.js is actually exported, and `incidentRecords` (the
// sanctioned wire -> flat bridge they all use) returns the shape they read.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '../../scripts');
const LIB_SPECIFIER = '../src/lib/incidents.js';

// Pull the named imports a script pulls from incidents.js out of its source.
// Handles single- and multi-line `import { a, b } from '...'` blocks and
// strips `as` aliases down to the imported (left-hand) name.
function importedNamesFrom(source, specifier) {
  const re = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    'g',
  );
  const names = [];
  for (const match of source.matchAll(re)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function scriptsImportingIncidentsLib() {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, source: readFileSync(resolve(SCRIPTS_DIR, f), 'utf8') }))
    .filter(({ source }) => source.includes(LIB_SPECIFIER));
}

describe('build scripts ↔ incidents.js exports', () => {
  const scripts = scriptsImportingIncidentsLib();

  it('finds the build scripts that depend on incidents.js', () => {
    // Sanity check the discovery itself — if this regex/glob silently matches
    // nothing, the per-script assertions below would vacuously pass.
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts)('$file imports only names incidents.js exports', ({ source }) => {
    const exported = new Set(Object.keys(incidentsLib));
    for (const name of importedNamesFrom(source, LIB_SPECIFIER)) {
      expect(exported, `incidents.js must export "${name}"`).toContain(name);
    }
  });
});

describe('incidentRecords wire → row contract', () => {
  const NOW = 1_000_000_000_000;
  const ALERT_URL = 'https://bsky.app/profile/did:plc:abc/post/3ml5idb536d2c';
  const OBS_URL = 'https://bsky.app/profile/did:plc:xyz/post/3mkuutqcneg2h';

  const incidents = [
    incident({
      id: '3ml5idb536d2c',
      kind: 'metro',
      routes: ['l1'],
      cta: {
        alert_id: 'a1',
        headline: 'Red Line Delays',
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: NOW - 30 * 60_000,
        active: false,
        post_url: ALERT_URL,
      },
      observations: [
        {
          id: 1,
          kind: 'metro',
          line: 'l1',
          ts: NOW - 55 * 60_000,
          post_url: OBS_URL,
        },
      ],
    }),
    incident({
      id: '3mkomsa7xhv2i',
      kind: 'bus',
      routes: ['22'],
      cta: null,
      observations: [{ id: 2, kind: 'bus', line: '22', ts: NOW - 10 * 60_000, post_url: 'x' }],
    }),
  ];

  it('expands cta blocks into official records the export scripts read', () => {
    const { officialRecords } = incidentRecords(incidents);
    expect(officialRecords).toHaveLength(1); // only the incident with a cta block
    const [alert] = officialRecords;
    // Fields the scripts actually consume (csv rows, OG cards, sitemap rkeys).
    expect(alert).toMatchObject({
      kind: 'metro',
      routes: ['l1'],
      headline: 'Red Line Delays',
      post_url: ALERT_URL,
      active: false,
    });
  });

  it('emits one detection record per nested detection, tagged with its incident', () => {
    const { detectionRecords } = incidentRecords(incidents);
    expect(detectionRecords).toHaveLength(2);
    expect(detectionRecords.map((o) => o._incidentId)).toEqual(['3ml5idb536d2c', '3mkomsa7xhv2i']);
    expect(detectionRecords[0]).toMatchObject({ post_url: OBS_URL, line: 'l1' });
  });

  it('prerenders one stub per incident id for grouped v2 incidents', () => {
    const grouped = incident({
      id: 'alert-136615',
      kind: 'rail',
      routes: ['pao', 'med'],
      cta: {
        alert_id: '136615',
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
      },
      official_alerts: [
        officialAlertFromAgency({ alert_id: '136615', headline: 'Track Construction' }),
        officialAlertFromAgency({ alert_id: '136616', headline: 'Track Construction' }),
      ],
      observations: [{ id: 'delay-2026-06-13-1234' }],
    });
    const flat = incidentRecords([grouped]);
    const picked = pickIncidents({ incidents: [grouped], ...flat });
    // The official alert and its detection collapse into one event page.
    expect([...picked.keys()]).toEqual(['alert-136615']);
  });

  it('expands v2 official_alert and detections into incident-derived records', () => {
    const { officialRecords, detectionRecords } = incidentRecords([
      {
        id: 'v2',
        agency: 'cta',
        mode: 'metro',
        routes: ['l1'],
        lifecycle: {
          first_seen_ts: NOW - 60 * 60_000,
          resolved_ts: NOW - 30 * 60_000,
          active: false,
        },
        official_alert: {
          id: 'v2-alert',
          headline: 'Red Line Delays',
          description: 'Delayed near Howard.',
          post_url: ALERT_URL,
          lifecycle: {
            first_seen_ts: NOW - 60 * 60_000,
            resolved_ts: NOW - 30 * 60_000,
            active: false,
          },
          scope: {
            from_station: 'Howard',
            to_station: 'Loyola',
            direction: 'toward 95th/Dan Ryan',
            stations: ['Howard', 'Jarvis', 'Morse', 'Loyola'],
            mentioned_stations: [],
          },
          agency_event_window: {
            start_ts: null,
            end_ts: null,
            start_is_date_only: false,
            end_is_date_only: false,
          },
        },
        detections: [
          {
            id: 7,
            source: 'pulse-cold',
            scope: {
              route: 'l1',
              from_station: 'Howard',
              to_station: 'Loyola',
              direction_label: 'toward 95th/Dan Ryan',
              stations: ['Howard', 'Jarvis', 'Morse', 'Loyola'],
            },
            lifecycle: {
              first_seen_ts: NOW - 55 * 60_000,
              onset_ts: NOW - 70 * 60_000,
              resolved_ts: NOW - 35 * 60_000,
              active: false,
            },
            post_url: OBS_URL,
            description: 'Red Line service appears degraded.',
            evidence: { signals: null, details: null, bullets: [] },
          },
        ],
      },
    ]);

    expect(officialRecords[0]).toMatchObject({
      alert_id: 'v2-alert',
      kind: 'metro',
      headline: 'Red Line Delays',
      affected_from_station: 'Howard',
      affected_to_station: 'Loyola',
      affected_stations: ['Howard', 'Jarvis', 'Morse', 'Loyola'],
    });
    expect(detectionRecords[0]).toMatchObject({
      id: 7,
      kind: 'metro',
      line: 'l1',
      detection_source: 'pulse-cold',
      from_station: 'Howard',
      to_station: 'Loyola',
      _incidentId: 'v2',
    });
  });

  it('tolerates a missing/empty incidents list', () => {
    expect(incidentRecords([])).toMatchObject({ officialRecords: [], detectionRecords: [] });
    expect(incidentRecords(undefined)).toMatchObject({ officialRecords: [], detectionRecords: [] });
  });
});
