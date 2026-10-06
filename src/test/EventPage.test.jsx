import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventPage from '../components/EventPage.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;

// Build the published incident wire shape: a top-level incident with a nullable
// official block (`cta` in the shared test vocabulary) and an `observations[]`
// list. Line keys are SEPTA's lowercase route keys ('l1', 't1', 'pao').
function officialBlock(over) {
  return {
    alert_id: 'a',
    headline: '',
    short_description: null,
    mentioned_stations: [],
    affected_from_station: null,
    affected_to_station: null,
    affected_direction: null,
    resolved_reply_url: null,
    agency_event_start_ts: null,
    agency_event_end_ts: null,
    agency_event_start_is_date_only: false,
    agency_event_end_is_date_only: false,
    ...over,
  };
}

const PAYLOAD = {
  generated_at: NOW,
  data_start_ts: NOW - 90 * 24 * 60 * 60_000,
  incidents: [
    {
      id: 'alert-1001',
      kind: 'metro',
      routes: ['l1'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 30 * 60_000,
      active: false,
      cta: officialBlock({
        alert_id: '1001',
        headline: 'L1 Delays at 69th St Transit Center',
        source_url: 'https://www.septa.org/schedules/L1',
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: NOW - 30 * 60_000,
        active: false,
      }),
      observations: [],
    },
    {
      id: 'alert-erie',
      kind: 'metro',
      routes: ['b1'],
      first_seen_ts: NOW - 45 * 60_000,
      resolved_ts: NOW - 15 * 60_000,
      active: false,
      cta: officialBlock({
        alert_id: 'erie',
        headline: 'B1 Delays',
        short_description:
          'B1 service is experiencing delays due to a water main break on Erie Avenue. Trains are bypassing Erie.',
        mentioned_stations: ['Erie'],
        first_seen_ts: NOW - 45 * 60_000,
        resolved_ts: NOW - 15 * 60_000,
        active: false,
      }),
      observations: [],
    },
    {
      id: 'detour-d17',
      kind: 'bus',
      routes: ['17', '33'],
      first_seen_ts: NOW - 30 * 60_000,
      resolved_ts: NOW - 5 * 60_000,
      active: false,
      cta: officialBlock({
        alert_id: 'D17',
        headline: 'Detour: Market St Closed',
        short_description: 'Market St will be closed between 15th St and 17th St.',
        affected_from_station: '15th St',
        affected_to_station: '17th St',
        first_seen_ts: NOW - 30 * 60_000,
        resolved_ts: NOW - 5 * 60_000,
        active: false,
      }),
      observations: [],
    },
    {
      // Multi-line Center City incident: the SEPTA alert grouped with one
      // pulse-cold detection per line (L1 primary, T1 extra).
      id: 'centercity',
      kind: 'metro',
      routes: ['l1', 't1'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['septa', 'bot'],
      cta: officialBlock({
        alert_id: 'cc1',
        headline: 'Center City Subway Service Delayed',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
      }),
      observations: [
        {
          id: 201,
          kind: 'metro',
          line: 'l1',
          from_station: '34th St',
          to_station: '8th-Market',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
        },
        {
          id: 202,
          kind: 'metro',
          line: 't1',
          from_station: '33rd St',
          to_station: '19th St',
          detection_source: 'pulse-cold',
          ts: NOW - 36 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
        },
      ],
    },
    {
      // Shared-trackage incident: SEPTA scopes it to T1 AND T2, but the bot
      // only fired one pulse-cold on T1 between 33rd St and 19th St — trolley
      // tunnel stations that serve T2 too. The page must fan the stretch onto
      // T2 so it isn't presented as T1-only.
      id: 'sharedtrk',
      kind: 'metro',
      routes: ['t1', 't2'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['septa', 'bot'],
      cta: officialBlock({
        alert_id: 'shared1',
        headline: 'Trolley Tunnel Delays Affecting T1 and T2 Service',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
      }),
      observations: [
        {
          id: 301,
          kind: 'metro',
          line: 't1',
          from_station: '33rd St',
          to_station: '19th St',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
        },
      ],
    },
    {
      // Guard against shared-trackage false positives: a T1-only alert on the
      // tunnel stretch that T2 ALSO runs. Because the SEPTA alert scopes the
      // incident to T1 alone (routes: ['t1']), T2 must NOT be pulled in —
      // shared trackage only spreads across lines the incident already names,
      // never invents new ones.
      id: 't1only',
      kind: 'metro',
      routes: ['t1'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['septa', 'bot'],
      cta: officialBlock({
        alert_id: 't1p1',
        headline: 'T1 Delays near 33rd St',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
      }),
      observations: [
        {
          id: 401,
          kind: 'metro',
          line: 't1',
          from_station: '33rd St',
          to_station: '19th St',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
        },
      ],
    },
    {
      id: 'gap-66',
      kind: 'bus',
      routes: ['66'],
      first_seen_ts: NOW - 10 * 60_000,
      resolved_ts: null,
      active: true,
      cta: null,
      observations: [
        {
          id: 99,
          kind: 'bus',
          line: '66',
          ts: NOW - 10 * 60_000,
          resolved_ts: null,
          active: true,
        },
      ],
    },
    {
      // Obs-only pulse-cold with a back-dated concrete onset. "First seen"
      // tracks onset_ts (80 min ago) but the detection is only 10 min ago;
      // the timeline must carry a third "Per bot" entry at the onset, ahead of
      // the detection and clear entries, so the rail lines up with First seen.
      id: 't3onset',
      kind: 'metro',
      routes: ['t3'],
      first_seen_ts: NOW - 80 * 60_000,
      resolved_ts: NOW - 4 * 60_000,
      active: false,
      cta: null,
      observations: [
        {
          id: 502,
          kind: 'metro',
          line: 't3',
          from_station: '40th St Portal',
          to_station: '33rd St',
          detection_source: 'pulse-cold',
          ts: NOW - 10 * 60_000,
          onset_ts: NOW - 80 * 60_000,
          resolved_ts: NOW - 4 * 60_000,
          active: false,
          bot_description: 'T3 service appears degraded — a stretch of the line without trolleys.',
          bot_resolved_description:
            'Trolleys observed again on the T3, service appears to be back to normal.',
          onset_description:
            'Last trolley observed through this stretch around here — the service gap began about now.',
        },
      ],
    },
    {
      id: 'cancel-972',
      kind: 'rail',
      routes: ['lan'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 60 * 60_000,
      active: false,
      cta: null,
      observations: [
        {
          id: 'cancel-972',
          kind: 'rail',
          line: 'lan',
          from_station: 'Suburban Station',
          to_station: 'Doylestown',
          detection_source: 'cancellation-inferred',
          ts: NOW - 60 * 60_000,
          onset_ts: NOW - 65 * 60_000,
          resolved_ts: NOW - 60 * 60_000,
          active: false,
          bot_description: 'Scheduled train not seen running — the 9:55 AM Doylestown train',
        },
      ],
    },
    {
      id: 'delay-991',
      kind: 'rail',
      routes: ['wtr'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 60 * 60_000,
      active: false,
      cta: null,
      observations: [
        {
          id: 'delay-991',
          kind: 'rail',
          line: 'wtr',
          train_number: '121',
          from_station: 'West Trenton',
          to_station: 'Gray 30th Street',
          detection_source: 'delay',
          ts: NOW - 60 * 60_000,
          onset_ts: NOW - 65 * 60_000,
          resolved_ts: NOW - 60 * 60_000,
          active: false,
          bot_description: '~70 min late — the 12:20 PM West Trenton train',
        },
      ],
    },
    {
      id: 'alert-rail-delay',
      kind: 'rail',
      routes: ['lan'],
      first_seen_ts: NOW - 45 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      cta: officialBlock({
        alert_id: 'rail-delay-1',
        headline: 'Lansdale/Doylestown Train #426 Delayed',
        short_description:
          'Train #426, scheduled to arrive Suburban Station at 3:36 PM, is operating 30 to 35 minutes behind schedule due to switch problems.',
        first_seen_ts: NOW - 45 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
      }),
      rail_status: {
        source: 'delay',
        deadline_ts: NOW - 10 * 60_000,
        delay_min: 35,
        train_number: '426',
      },
      observations: [],
    },
    {
      // Future planned work (advance-notice track construction). Posted today,
      // work happens this weekend — so "Ongoing for" counting from first_seen
      // is meaningless. Should relabel "First seen" → "Announced", drop the
      // timer, and show a neutral "planned" pill instead of red "ongoing".
      id: 'alert-rail-planned',
      kind: 'rail',
      routes: ['pao', 'war', 'med', 'wtr', 'lan', 'tre', 'wil'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: null,
      active: true,
      cta: officialBlock({
        alert_id: 'rail-planned-1',
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description:
          'Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to 15 minutes behind schedule passing through the work zone.',
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: null,
        active: true,
      }),
      rail_status: { source: 'planned-delay', train_number: null },
      observations: [],
    },
  ].map((inc) => incident(inc)),
};

const V2_PAYLOAD = {
  schema_version: 2,
  generated_at: NOW + 1,
  data_start_ts: NOW - 90 * 24 * 60 * 60_000,
  incidents: [
    {
      id: 'v2evt',
      agency: 'septa',
      mode: 'metro',
      routes: ['l1'],
      sources: ['septa', 'bot'],
      lifecycle: {
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: NOW - 20 * 60_000,
        active: false,
        duration_ms: 40 * 60_000,
      },
      official_alert: {
        id: 'v2-alert',
        headline: 'L1 Service Delayed',
        description: 'L1 trains are delayed between Frankford Transit Center and Erie-Torresdale.',
        post_url: null,
        source_url: 'https://www.septa.org/schedules/L1',
        resolved_reply_url: null,
        lifecycle: {
          first_seen_ts: NOW - 60 * 60_000,
          resolved_ts: NOW - 20 * 60_000,
          active: false,
          duration_ms: 40 * 60_000,
        },
        scope: {
          from_station: 'Frankford Transit Center',
          to_station: 'Erie-Torresdale',
          stations: [
            'Frankford Transit Center',
            'Arrott Transit Center',
            'Church',
            'Erie-Torresdale',
          ],
          direction: 'toward 69th St Transit Center',
          mentioned_stations: [],
        },
        agency_event_window: {
          start_ts: null,
          end_ts: null,
          start_is_date_only: false,
          end_is_date_only: false,
        },
        septa: { type: 'ALERT', cause: null, effect: 'SIGNIFICANT_DELAYS', severity: null },
      },
      detections: [
        {
          id: 9001,
          source: 'pulse-cold',
          scope: {
            route: 'l1',
            from_station: 'Frankford Transit Center',
            to_station: 'Erie-Torresdale',
            stations: [
              'Frankford Transit Center',
              'Arrott Transit Center',
              'Church',
              'Erie-Torresdale',
            ],
            direction: 'branch-0-inbound',
            direction_label: 'toward 69th St Transit Center',
          },
          lifecycle: {
            first_seen_ts: NOW - 55 * 60_000,
            onset_ts: NOW - 70 * 60_000,
            resolved_ts: NOW - 22 * 60_000,
            active: false,
            duration_ms: 48 * 60_000,
          },
          post_url: null,
          resolved_post_url: null,
          description: 'L1 service appears degraded — a stretch without trains.',
          evidence: {
            signals: null,
            details: null,
            bullets: [],
            onset_description: 'Last train observed through this stretch around here.',
            train_number: null,
            resolved_description: null,
          },
        },
      ],
      status: null,
    },
    {
      id: 'v2thingap',
      agency: 'septa',
      mode: 'bus',
      routes: ['21'],
      sources: ['bot'],
      lifecycle: {
        first_seen_ts: NOW - 3 * 60 * 60_000,
        resolved_ts: NOW - 4 * 60_000,
        active: false,
        duration_ms: 3 * 60 * 60_000 - 4 * 60_000,
      },
      official_alert: null,
      detections: [
        {
          id: 'd-21',
          source: 'thin-gap',
          scope: { route: '21' },
          lifecycle: {
            first_seen_ts: NOW - 3 * 60 * 60_000,
            onset_ts: null,
            resolved_ts: NOW - 4 * 60_000,
            active: false,
            duration_ms: 3 * 60 * 60_000 - 4 * 60_000,
          },
          post_url: null,
          resolved_post_url: null,
          description: 'Route 21 thin-service gap',
          evidence: {
            signals: ['thin-gap'],
            details: { headwayMin: 30 },
            bullets: [],
            onset_description: null,
            resolved_description:
              'Buses observed on Route 21 again — earlier thin-service gap has cleared.',
            updates: [
              {
                ts: NOW - 2 * 60 * 60_000,
                description:
                  '🚌 Route 21 · still no buses observed — ~1h in, ~2 scheduled trips missed so far.',
                post_url: null,
                evidence: { elapsedMin: 60, headwayMin: 30, missedTrips: 2 },
              },
              {
                ts: NOW - 60 * 60_000,
                description:
                  '🚌 Route 21 · still no buses observed — ~2h in, ~4 scheduled trips missed so far.',
                post_url: null,
                evidence: { elapsedMin: 120, headwayMin: 30, missedTrips: 4 },
              },
            ],
          },
        },
      ],
      status: null,
    },
    {
      id: 'trip-cancellations-2001-09-08-23',
      agency: 'septa',
      mode: 'bus',
      routes: ['23'],
      sources: ['bot'],
      lifecycle: {
        first_seen_ts: NOW - 2 * 60 * 60_000,
        resolved_ts: null,
        active: true,
        duration_ms: null,
      },
      official_alert: null,
      detections: [
        {
          id: 'trip-cancellations-2001-09-08-23',
          source: 'trip-cancellations',
          scope: { route: '23' },
          lifecycle: {
            first_seen_ts: NOW - 2 * 60 * 60_000,
            onset_ts: null,
            resolved_ts: null,
            active: true,
            duration_ms: null,
          },
          post_url: null,
          resolved_post_url: null,
          description: '2 Route 23 trips cancelled — 5:06 AM, 9:14 AM (2 of 225 scheduled)',
          evidence: {
            signals: null,
            details: {
              kind: 'trip-cancellations',
              service_date: '2001-09-08',
              cancelled: 2,
              scheduled: 225,
              trips: [
                {
                  trip_id: '958770',
                  direction: 0,
                  start_ts: NOW - 60 * 60_000,
                  end_ts: NOW - 60 * 60_000 + 50 * 60_000,
                  origin: 'Chestnut Hill Loop',
                  destination: '11th St & Market St',
                },
                {
                  trip_id: '958782',
                  direction: 0,
                  start_ts: NOW + 3 * 60 * 60_000,
                  end_ts: NOW + 3 * 60 * 60_000 + 50 * 60_000,
                  origin: '11th St & Market St - FS',
                  destination: 'Chestnut Hill Loop',
                },
              ],
            },
            bullets: ['2 of 225 scheduled trips cancelled'],
            onset_description: null,
            updates: [],
          },
        },
      ],
      status: null,
    },
  ],
};

beforeEach(() => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) }),
  );
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  });
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
  }
});

afterEach(() => {
  // Unmount before restoring globals — EventPage installs a 5-minute
  // setInterval polling fetch, and the closure pins data + station index
  // until React tears the tree down. Without this, each test leaves a
  // multi-MB graph alive and the suite OOMs in CI.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EventPage', () => {
  it('renders the matching alert by event id', async () => {
    render(<EventPage eventId="alert-1001" />);
    await waitFor(() => {
      expect(screen.getByText('L1 Delays at 69th St Transit Center')).toBeInTheDocument();
    });
    // SEPTA alerts have no permalink; the route's SEPTA.org page is the source.
    expect(screen.getByText('SEPTA.org →').closest('a')).toHaveAttribute(
      'href',
      'https://www.septa.org/schedules/L1',
    );
    // Breadcrumb replaces the old "← Back" link: Home › <day> › <route>.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(crumbs).getByText('L1 Market-Frankford Line')).toBeInTheDocument();
  });

  it("links the alerts bot's Bluesky post alongside SEPTA.org", async () => {
    const post = 'https://bsky.app/profile/did:plc:alerts/post/3k2j';
    const withPost = {
      ...PAYLOAD,
      incidents: PAYLOAD.incidents.map((inc) =>
        inc.id === 'alert-1001'
          ? { ...inc, official_alert: { ...inc.official_alert, post_url: post } }
          : inc,
      ),
    };
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(withPost) }),
    );
    render(<EventPage eventId="alert-1001" />);
    await waitFor(() => {
      expect(screen.getByText('View on Bluesky →').closest('a')).toHaveAttribute('href', post);
    });
    expect(screen.getByText('SEPTA.org →').closest('a')).toHaveAttribute(
      'href',
      'https://www.septa.org/schedules/L1',
    );
  });

  it('renders a v2-only incident payload after fetch normalization', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(V2_PAYLOAD) }),
    );
    render(<EventPage eventId="v2evt" />);
    await waitFor(() => {
      expect(screen.getByText('L1 Service Delayed')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Per SEPTA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Per bot/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Erie-Torresdale' }).length).toBeGreaterThan(0);
  });

  it('renders hourly progress updates on a bot-only absence incident timeline', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(V2_PAYLOAD) }),
    );
    render(<EventPage eventId="v2thingap" />);
    // The detector's sentence is both the page title and the detection entry.
    await waitFor(() => {
      expect(screen.getAllByText(/Route 21 thin-service gap/).length).toBeGreaterThan(0);
    });
    // Each hourly update is its own entry on the Per bot rail, between the
    // detection and the resolution.
    expect(
      screen.getByText(/still no buses observed — ~1h in, ~2 scheduled trips missed/),
    ).toBeInTheDocument();
    // resolution + 2 updates + detection = 4 entries (no onset for this fixture).
    expect(screen.getByText(/Per bot · 4 updates/)).toBeInTheDocument();
  });

  it("lists a route's cancelled trips and credits SEPTA's trip feed", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(V2_PAYLOAD) }),
    );
    render(<EventPage eventId="trip-cancellations-2001-09-08-23" />);
    await waitFor(() => {
      expect(screen.getByText('Cancelled trips · 2')).toBeInTheDocument();
    });
    expect(screen.getByText(/real-time trip feed/)).toBeInTheDocument();
    expect(screen.queryByText(/live vehicle tracking/)).not.toBeInTheDocument();
    expect(screen.getByText('Chestnut Hill Loop → 11th St & Market St')).toBeInTheDocument();
    expect(screen.getByText('11th St & Market St → Chestnut Hill Loop')).toBeInTheDocument();
  });

  it('renders a standalone observation by id', async () => {
    render(<EventPage eventId="gap-66" />);
    // "Route 66" appears both in the breadcrumb's current crumb and the page
    // body, so assert presence rather than uniqueness.
    await waitFor(() => {
      expect(screen.getAllByText('Route 66').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('ongoing')).toBeInTheDocument();
  });

  it('renders an inferred Regional Rail cancellation with a cancellation-style layout', async () => {
    render(<EventPage eventId="cancel-972" />);
    await waitFor(() => {
      expect(
        screen.getByText('Scheduled train not seen running — the 9:55 AM Doylestown train'),
      ).toBeInTheDocument();
    });
    // "possible cancellation" badge, scheduled-departure relabel, and no
    // duration/last-seen framing (a train that never ran).
    expect(screen.getByText('possible cancellation')).toBeInTheDocument();
    expect(screen.getByText('Scheduled departure')).toBeInTheDocument();
    expect(screen.queryByText('First seen')).not.toBeInTheDocument();
    expect(screen.queryByText('Last seen')).not.toBeInTheDocument();
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
    // The run (origin → destination) survives even though the map is dropped.
    expect(screen.getByText('Suburban Station')).toBeInTheDocument();
    expect(screen.getByText('Doylestown')).toBeInTheDocument();
  });

  it('renders a bot-only Regional Rail delay title with the train number when available', async () => {
    render(<EventPage eventId="delay-991" />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /West Trenton Line train #121 delayed/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /12:20 PM West Trenton train/i })).toBeNull();
  });

  it('shows a delay badge for an official-only Regional Rail delay alert', async () => {
    render(<EventPage eventId="alert-rail-delay" />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Lansdale\/Doylestown Line train #426 delayed/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText('delayed').length).toBeGreaterThan(0);
  });

  it('relabels and de-times a future planned-work alert', async () => {
    render(<EventPage eventId="alert-rail-planned" />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Track Construction Saturday/i }),
      ).toBeInTheDocument();
    });
    const article = screen.getByRole('article');
    // The disruption hasn't started: count-up framing is wrong.
    expect(within(article).getByText('Announced')).toBeInTheDocument();
    expect(within(article).queryByText('First seen')).not.toBeInTheDocument();
    expect(within(article).queryByText('Ongoing for')).not.toBeInTheDocument();
    // The "planned work" badge carries the status; no redundant "planned"
    // pill, and no red "ongoing" marker before the work starts.
    expect(within(article).getByText('planned work')).toBeInTheDocument();
    expect(within(article).queryByText('ongoing')).not.toBeInTheDocument();
    expect(within(article).queryByText('planned')).not.toBeInTheDocument();
    // A multi-line parent can't name one line in the "Surrounding 24 hours"
    // header — it generalizes to the network and turns on per-row line pills
    // so each related row says which line it's on.
    expect(
      screen.getByText('Surrounding 24 hours on affected Regional Rail lines'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Surrounding 24 hours on 7 /)).not.toBeInTheDocument();
  });

  it('shows a not-found message for an unknown id', async () => {
    render(<EventPage eventId="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });
  });

  it('does not link a station name when it is followed by a street suffix', async () => {
    // "Erie Avenue" should not be linked to the Erie station even when Erie is
    // in mentioned_stations. A bare "Erie" elsewhere in the same text should
    // still link.
    render(<EventPage eventId="alert-erie" />);
    await waitFor(() => {
      expect(screen.getByText(/water main break/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /^Erie Avenue$/ })).toBeNull();
    // The bare "Erie" later in the sentence still links.
    expect(screen.getAllByRole('link', { name: 'Erie' }).length).toBeGreaterThan(0);
  });

  it('aggregates affected stations across all merged observations', async () => {
    // The merged Center City incident pairs the alert with two pulse-cold obs
    // on different lines. The chips must list endpoints from BOTH (primary +
    // extra), not just the primary's stretch — otherwise a multi-line incident
    // reads as one arbitrary stretch.
    render(<EventPage eventId="centercity" />);
    await waitFor(() => {
      expect(screen.getByText('Center City Subway Service Delayed')).toBeInTheDocument();
    });
    // Primary obs (L1) endpoint. It can appear in both the affected-stations
    // chips and the per-obs stretch line in the timeline rail, so allow >=1.
    expect(screen.getAllByRole('link', { name: '34th St' }).length).toBeGreaterThan(0);
    // Extra obs (T1) endpoints — proves we go beyond the primary observation.
    expect(screen.getAllByRole('link', { name: '33rd St' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: '19th St' }).length).toBeGreaterThan(0);
  });

  it('renders the combined multi-line map for a multi-line incident', async () => {
    render(<EventPage eventId="centercity" />);
    await waitFor(() => {
      expect(screen.getByText('Center City Subway Service Delayed')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('img', { name: /Affected stretches across 2 Metro lines/ }),
    ).toBeInTheDocument();
    // Bot-detected stretches are labeled as observed impact, not "where this
    // happened" — they spread downstream of SEPTA's reported epicenter.
    expect(screen.getByText('Bot observed impact')).toBeInTheDocument();
    expect(screen.queryByText('Where this happened')).not.toBeInTheDocument();
  });

  it('fans a bot stretch onto sibling lines that share the trackage', async () => {
    // The bot's pulse-cold was scoped to T1, but 33rd St↔19th St also carries
    // T2 and the SEPTA alert names both lines. The station list and map must
    // surface T2 alongside T1 — and reframe the copy so the inferred T2 rows
    // don't masquerade as separate bot detections.
    render(<EventPage eventId="sharedtrk" />);
    await waitFor(() => {
      expect(
        screen.getByText('Trolley Tunnel Delays Affecting T1 and T2 Service'),
      ).toBeInTheDocument();
    });
    // Reworded section label (not "Bot observed impacted stations").
    expect(screen.getByText('Affected stations (shared trackage)')).toBeInTheDocument();
    // Map heading reframed away from crediting the bot for the T2 stretch.
    expect(screen.getByText('Affected stretches')).toBeInTheDocument();
    expect(screen.queryByText('Bot observed impact')).not.toBeInTheDocument();
  });

  it('does not pull in a non-incident line that merely shares the trackage', async () => {
    // T1-only alert on the trolley tunnel, which T2 also runs. T2 is not in the
    // incident's routes, so it must stay out — the shared-track fan-out only
    // spreads across lines the SEPTA alert already named.
    render(<EventPage eventId="t1only" />);
    await waitFor(() => {
      expect(screen.getByText('T1 Delays near 33rd St')).toBeInTheDocument();
    });
    const article = within(screen.getByRole('article'));
    // No fan-out happened, so the original (non-shared) framing stays.
    expect(article.queryByText('Affected stations (shared trackage)')).not.toBeInTheDocument();
    expect(article.getByText('Bot observed impacted stations')).toBeInTheDocument();
  });

  it('adds a cleared entry to the Per SEPTA timeline when the alert resolved', async () => {
    // The B1 alert is resolved with SEPTA body text. The timeline should end
    // on a "cleared" entry (newest) so it doesn't read as still ongoing.
    render(<EventPage eventId="alert-erie" />);
    await waitFor(() => {
      expect(screen.getByText('SEPTA cleared this alert.')).toBeInTheDocument();
    });
    // Original message (1) + clear (1) = 2 updates.
    expect(screen.getByText(/Per SEPTA · 2 updates/)).toBeInTheDocument();
    // The SEPTA body text still renders in its version entry.
    expect(screen.getByText(/water main break/)).toBeInTheDocument();
  });

  it('adds an onset entry to the Per bot timeline for a back-dated cold start', async () => {
    // pulse-cold fires only after the stretch has been cold a while, so the
    // detection dot lands well after the gap began. With onset_description +
    // onset_ts the rail gains a third entry at the real start.
    render(<EventPage eventId="t3onset" />);
    await waitFor(() => {
      expect(
        screen.getByText(/Last trolley observed through this stretch around here/),
      ).toBeInTheDocument();
    });
    // onset (1) + detection (1) + clear (1) = 3 updates.
    expect(screen.getByText(/Per bot · 3 updates/)).toBeInTheDocument();
    // The detection entry carries the ALERTED badge (when the bot raised the
    // alarm); the resolution stays the Latest entry.
    expect(screen.getByText('Alerted')).toBeInTheDocument();
    expect(screen.getByText('Latest')).toBeInTheDocument();
    expect(
      screen.getByText('Trolleys observed again on the T3, service appears to be back to normal.'),
    ).toBeInTheDocument();
  });

  it('does not render a station chips row for bus alerts', async () => {
    // affected_from_station / affected_to_station on bus alerts hold
    // cross-street labels, not rail stations — linking them would produce
    // station pages for streets. The chips are suppressed for kind=bus so the
    // broken links never appear.
    render(<EventPage eventId="detour-d17" />);
    await waitFor(() => {
      expect(screen.getByText('Detour: Market St Closed')).toBeInTheDocument();
    });
    expect(screen.queryByText('Stations')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '15th St' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '17th St' })).not.toBeInTheDocument();
  });
});
