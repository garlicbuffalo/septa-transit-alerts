import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventPage from '../components/EventPage.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;

// Build the published incident wire shape: a top-level incident with a nullable
// `cta` block and an `observations[]` list. Train line keys are already full
// names ('purple') — normalization now happens server-side.
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
      id: 'abc123',
      kind: 'metro',
      routes: ['red'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 30 * 60_000,
      active: false,
      sources: ['cta'],
      cta: officialBlock({
        alert_id: 'a1',
        headline: 'Red Line Delays at Howard',
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: NOW - 30 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/abc123',
      }),
      observations: [],
    },
    {
      id: 'brnriver',
      kind: 'metro',
      routes: ['brown'],
      first_seen_ts: NOW - 45 * 60_000,
      resolved_ts: NOW - 15 * 60_000,
      active: false,
      sources: ['cta'],
      cta: officialBlock({
        alert_id: 'a3',
        headline: 'Brown Line Delays',
        short_description:
          'Brown Line service is experiencing delays due to a raised bridge at the Chicago River, downtown. Trains stopped near Chicago.',
        mentioned_stations: ['Chicago (Brown)'],
        first_seen_ts: NOW - 45 * 60_000,
        resolved_ts: NOW - 15 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/brnriver',
      }),
      observations: [],
    },
    {
      id: 'busreroute',
      kind: 'bus',
      routes: ['2', '6'],
      first_seen_ts: NOW - 30 * 60_000,
      resolved_ts: NOW - 5 * 60_000,
      active: false,
      sources: ['cta'],
      cta: officialBlock({
        alert_id: 'a2',
        headline: 'Temporary Reroute',
        short_description: 'SB State will be closed between Wacker and Randolph.',
        affected_from_station: 'Wacker',
        affected_to_station: 'Randolph',
        first_seen_ts: NOW - 30 * 60_000,
        resolved_ts: NOW - 5 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/busreroute',
      }),
      observations: [],
    },
    {
      // Multi-line Loop incident: the CTA alert grouped with one pulse-cold
      // detection per line (Purple primary, Pink extra).
      id: 'loopevt',
      kind: 'metro',
      routes: ['purple', 'pink'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['cta', 'bot'],
      cta: officialBlock({
        alert_id: 'loop1',
        headline: 'Loop Elevated Service Delayed',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/loopevt',
      }),
      observations: [
        {
          id: 201,
          kind: 'metro',
          line: 'purple',
          from_station: 'Belmont (Red/Brown/Purple)',
          to_station: 'Chicago (Brown/Purple)',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/obsPurple',
        },
        {
          id: 202,
          kind: 'metro',
          line: 'pink',
          from_station: 'Ashland (Green/Pink)',
          to_station: 'Washington/Wabash',
          detection_source: 'pulse-cold',
          ts: NOW - 36 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/obsPink',
        },
      ],
    },
    {
      // Shared-trackage incident: CTA scopes it to Pink AND Green, but the bot
      // only fired one pulse-cold on Pink between Ashland and Adams/Wabash —
      // both Lake St stations that serve Green too. The page must fan the
      // stretch onto Green so it isn't presented as Pink-only.
      id: 'sharedtrk',
      kind: 'metro',
      routes: ['pink', 'green'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['cta', 'bot'],
      cta: officialBlock({
        alert_id: 'shared1',
        headline: 'Delays near Ashland/Lake Affecting Green and Pink Line Service',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/sharedtrk',
      }),
      observations: [
        {
          id: 301,
          kind: 'metro',
          line: 'pink',
          from_station: 'Ashland (Green/Pink)',
          to_station: 'Adams/Wabash',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/obsSharedPink',
        },
      ],
    },
    {
      // Guard against shared-trackage false positives: a Brown-only alert on
      // the Belmont↔Fullerton stretch that Purple ALSO runs. Because the CTA
      // alert scopes the incident to Brown alone (routes: ['brown']), Purple
      // must NOT be pulled in — shared trackage only spreads across lines the
      // incident already names, never invents new ones.
      id: 'brnpurple',
      kind: 'metro',
      routes: ['brown'],
      first_seen_ts: NOW - 40 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['cta', 'bot'],
      cta: officialBlock({
        alert_id: 'brnp1',
        headline: 'Brown Line Delays near Belmont',
        first_seen_ts: NOW - 40 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/brnpurple',
      }),
      observations: [
        {
          id: 401,
          kind: 'metro',
          line: 'brown',
          from_station: 'Belmont (Red/Brown/Purple)',
          to_station: 'Fullerton',
          detection_source: 'pulse-cold',
          ts: NOW - 38 * 60_000,
          resolved_ts: NOW - 12 * 60_000,
          active: false,
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/obsBrnPurple',
        },
      ],
    },
    {
      id: 'bus99',
      kind: 'bus',
      routes: ['66'],
      first_seen_ts: NOW - 10 * 60_000,
      resolved_ts: null,
      active: true,
      sources: ['bot'],
      cta: null,
      observations: [
        {
          id: 99,
          kind: 'bus',
          line: '66',
          ts: NOW - 10 * 60_000,
          resolved_ts: null,
          active: true,
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/bus99',
        },
      ],
    },
    {
      // Obs-only pulse-cold with a back-dated concrete onset. "First seen"
      // tracks onset_ts (80 min ago) but the detection post is only 10 min ago;
      // the timeline must carry a third "Per bot" entry at the onset, ahead of
      // the detection and clear entries, so the rail lines up with First seen.
      id: 'greenonset',
      kind: 'metro',
      routes: ['green'],
      first_seen_ts: NOW - 80 * 60_000,
      resolved_ts: NOW - 4 * 60_000,
      active: false,
      sources: ['bot'],
      cta: null,
      observations: [
        {
          id: 502,
          kind: 'metro',
          line: 'green',
          from_station: 'Roosevelt',
          to_station: 'Cermak-McCormick Place',
          detection_source: 'pulse-cold',
          ts: NOW - 10 * 60_000,
          onset_ts: NOW - 80 * 60_000,
          resolved_ts: NOW - 4 * 60_000,
          active: false,
          bot_description:
            'Green Line service appears degraded — a stretch of the line without trains.',
          bot_resolved_description:
            'Trains observed again on the Green Line, service appears to be back to normal.',
          onset_description:
            'Last train observed through this stretch around here — the service gap began about now.',
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/greenonset',
          resolved_post_url: 'https://bsky.app/profile/did:plc:xyz/post/greenonsetclear',
        },
      ],
    },
    {
      id: 'metra-972',
      kind: 'rail',
      routes: ['ri'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 60 * 60_000,
      active: false,
      sources: ['bot'],
      cta: null,
      observations: [
        {
          id: 'metra-972',
          kind: 'rail',
          line: 'ri',
          from_station: 'LaSalle Street',
          to_station: 'Joliet',
          detection_source: 'cancellation-inferred',
          ts: NOW - 60 * 60_000,
          onset_ts: NOW - 65 * 60_000,
          resolved_ts: NOW - 60 * 60_000,
          active: false,
          bot_description: 'Scheduled train not seen running — the 9:55 AM Joliet train',
        },
      ],
    },
    {
      id: 'metra-991',
      kind: 'rail',
      routes: ['me'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 60 * 60_000,
      active: false,
      sources: ['bot'],
      cta: null,
      observations: [
        {
          id: 'metra-991',
          kind: 'rail',
          line: 'me',
          train_number: '121',
          from_station: 'Millennium Station',
          to_station: 'University Park',
          detection_source: 'delay',
          ts: NOW - 60 * 60_000,
          onset_ts: NOW - 65 * 60_000,
          resolved_ts: NOW - 60 * 60_000,
          active: false,
          bot_description: '~70 min late — the 12:20 PM University Park train',
        },
      ],
    },
    {
      id: 'metra-official-delay',
      kind: 'rail',
      routes: ['ri'],
      first_seen_ts: NOW - 45 * 60_000,
      resolved_ts: NOW - 10 * 60_000,
      active: false,
      sources: ['cta'],
      cta: officialBlock({
        alert_id: 'metra-delay-1',
        headline: 'RID #426 Delayed',
        short_description:
          'RID train #426, scheduled to arrive LaSalle Street Station at 3:36 PM, is operating 30 to 35 minutes behind schedule due to switch problems.',
        first_seen_ts: NOW - 45 * 60_000,
        resolved_ts: NOW - 10 * 60_000,
        active: false,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/rail-official-delay',
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
      id: 'metra-planned',
      kind: 'rail',
      routes: ['bnsf', 'md-n', 'md-w', 'me', 'ri', 'up-nw', 'up-w'],
      first_seen_ts: NOW - 60 * 60_000,
      resolved_ts: null,
      active: true,
      sources: ['cta'],
      cta: officialBlock({
        alert_id: 'metra-planned-1',
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description:
          'Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to 15 minutes behind scheduled passing through the work zone.',
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: null,
        active: true,
        post_url: 'https://bsky.app/profile/did:plc:abc/post/rail-planned',
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
      agency: 'cta',
      mode: 'metro',
      routes: ['red'],
      sources: ['cta', 'bot'],
      lifecycle: {
        first_seen_ts: NOW - 60 * 60_000,
        resolved_ts: NOW - 20 * 60_000,
        active: false,
        duration_ms: 40 * 60_000,
      },
      official_alert: {
        id: 'v2-alert',
        headline: 'Red Line Service Delayed',
        description: 'Red Line trains are delayed between Howard and Loyola.',
        post_url: 'https://bsky.app/profile/did:plc:abc/post/v2evt',
        resolved_reply_url: null,
        lifecycle: {
          first_seen_ts: NOW - 60 * 60_000,
          resolved_ts: NOW - 20 * 60_000,
          active: false,
          duration_ms: 40 * 60_000,
        },
        scope: {
          from_station: 'Howard',
          to_station: 'Loyola',
          stations: ['Howard', 'Jarvis', 'Morse', 'Loyola'],
          direction: 'toward 95th/Dan Ryan',
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
          id: 9001,
          source: 'pulse-cold',
          scope: {
            route: 'red',
            from_station: 'Howard',
            to_station: 'Loyola',
            stations: ['Howard', 'Jarvis', 'Morse', 'Loyola'],
            direction: 'branch-0-inbound',
            direction_label: 'toward 95th/Dan Ryan',
          },
          lifecycle: {
            first_seen_ts: NOW - 55 * 60_000,
            onset_ts: NOW - 70 * 60_000,
            resolved_ts: NOW - 22 * 60_000,
            active: false,
            duration_ms: 48 * 60_000,
          },
          post_url: 'https://bsky.app/profile/did:plc:xyz/post/v2obs',
          resolved_post_url: null,
          description: 'Red Line service appears degraded — a stretch without trains.',
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
      agency: 'cta',
      mode: 'bus',
      routes: ['22'],
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
          id: 'd-22',
          source: 'thin-gap',
          scope: { route: '22' },
          lifecycle: {
            first_seen_ts: NOW - 3 * 60 * 60_000,
            onset_ts: null,
            resolved_ts: NOW - 4 * 60_000,
            active: false,
            duration_ms: 3 * 60 * 60_000 - 4 * 60_000,
          },
          post_url: 'https://bsky.app/profile/did:plc:bus/post/thin22',
          resolved_post_url: 'https://bsky.app/profile/did:plc:bus/post/thin22clear',
          description: 'Route 22 thin-service gap',
          evidence: {
            signals: ['thin-gap'],
            details: { headwayMin: 30 },
            bullets: [],
            onset_description: null,
            resolved_description:
              'Buses observed on Route 22 again — earlier thin-service gap has cleared.',
            updates: [
              {
                ts: NOW - 2 * 60 * 60_000,
                description:
                  '🚌 Route 22 · still no buses observed — ~1h in, ~2 scheduled trips missed so far.',
                post_url: null,
                evidence: { elapsedMin: 60, headwayMin: 30, missedTrips: 2 },
              },
              {
                ts: NOW - 60 * 60_000,
                description:
                  '🚌 Route 22 · still no buses observed — ~2h in, ~4 scheduled trips missed so far.',
                post_url: null,
                evidence: { elapsedMin: 120, headwayMin: 30, missedTrips: 4 },
              },
            ],
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
    render(<EventPage eventId="abc123" />);
    await waitFor(() => {
      expect(screen.getByText('Red Line Delays at Howard')).toBeInTheDocument();
    });
    expect(screen.getByText('View on Bluesky →')).toBeInTheDocument();
    // Breadcrumb replaces the old "← Back" link: Home › <day> › <route>.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(crumbs).getByText('Red Line')).toBeInTheDocument();
  });

  it('renders a v2-only incident payload after fetch normalization', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(V2_PAYLOAD) }),
    );
    render(<EventPage eventId="v2evt" />);
    await waitFor(() => {
      expect(screen.getByText('Red Line Service Delayed')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Per CTA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Per bot/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Loyola' }).length).toBeGreaterThan(0);
  });

  it('renders hourly progress updates on a bot-only absence incident timeline', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(V2_PAYLOAD) }),
    );
    render(<EventPage eventId="v2thingap" />);
    await waitFor(() => {
      expect(screen.getByText(/Route 22 thin-service gap/)).toBeInTheDocument();
    });
    // Each hourly update is its own entry on the Per bot rail, between the
    // detection and the resolution.
    expect(
      screen.getByText(/still no buses observed — ~1h in, ~2 scheduled trips missed/),
    ).toBeInTheDocument();
    // resolution + 2 updates + detection = 4 entries (no onset for this fixture).
    expect(screen.getByText(/Per bot · 4 updates/)).toBeInTheDocument();
  });

  it('renders a standalone observation by id', async () => {
    render(<EventPage eventId="bus99" />);
    // "#66 Chicago" appears both in the breadcrumb's current crumb and the
    // page body, so assert presence rather than uniqueness.
    await waitFor(() => {
      expect(screen.getAllByText('#66 Chicago').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('ongoing')).toBeInTheDocument();
  });

  it('renders an inferred Metra cancellation with a cancellation-style layout', async () => {
    render(<EventPage eventId="metra-972" />);
    await waitFor(() => {
      expect(
        screen.getByText('Scheduled train not seen running — the 9:55 AM Joliet train'),
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
    expect(screen.getByText('LaSalle Street')).toBeInTheDocument();
    expect(screen.getByText('Joliet')).toBeInTheDocument();
  });

  it('renders a bot-only Metra delay title with the train number when available', async () => {
    render(<EventPage eventId="metra-991" />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Metra Electric train #121 delayed/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /12:20 PM University Park train/i })).toBeNull();
  });

  it('shows a delay badge for an official-only Metra delay alert', async () => {
    render(<EventPage eventId="metra-official-delay" />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Rock Island train #426 delayed/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText('delayed').length).toBeGreaterThan(0);
  });

  it('relabels and de-times a future planned-work alert', async () => {
    render(<EventPage eventId="metra-planned" />);
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
    // The Metra "planned work" badge carries the status; no redundant "planned"
    // pill, and no red "ongoing" marker before the work starts.
    expect(within(article).getByText('planned work')).toBeInTheDocument();
    expect(within(article).queryByText('ongoing')).not.toBeInTheDocument();
    expect(within(article).queryByText('planned')).not.toBeInTheDocument();
    // A multi-line parent can't name one line in the "Surrounding 24 hours"
    // header — it generalizes to the agency and turns on per-row line pills so
    // each related row says which line it's on.
    expect(screen.getByText('Surrounding 24 hours on affected Metra lines')).toBeInTheDocument();
    expect(screen.queryByText(/Surrounding 24 hours on 7 Metra lines/)).not.toBeInTheDocument();
  });

  it('shows a not-found message for an unknown id', async () => {
    render(<EventPage eventId="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });
  });

  it('does not link a station name when it is followed by a geographic suffix', async () => {
    // "Chicago River" / "Chicago Avenue" etc. should not be linked to the
    // Chicago station even when Chicago is in mentioned_stations. A bare
    // "Chicago" elsewhere in the same text should still link.
    render(<EventPage eventId="brnriver" />);
    await waitFor(() => {
      expect(screen.getByText(/raised bridge/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /^Chicago River$/ })).toBeNull();
    // The bare "Chicago" later in the sentence still links.
    expect(screen.getAllByRole('link', { name: 'Chicago' }).length).toBeGreaterThan(0);
  });

  it('aggregates affected stations across all merged observations', async () => {
    // The merged Loop incident pairs the alert with two pulse-cold obs on
    // different lines. The chips must list endpoints from BOTH (primary +
    // extra), not just the primary's Belmont/Chicago — otherwise a five-line
    // incident reads as one arbitrary stretch.
    render(<EventPage eventId="loopevt" />);
    await waitFor(() => {
      expect(screen.getByText('Loop Elevated Service Delayed')).toBeInTheDocument();
    });
    // Primary obs (Purple) endpoints. Belmont/Chicago can appear in both the
    // affected-stations chips and the per-obs stretch line in the timeline
    // rail, so allow >=1 match.
    expect(screen.getAllByRole('link', { name: 'Belmont' }).length).toBeGreaterThan(0);
    // Extra obs (Pink) endpoint — proves we go beyond the primary observation.
    expect(screen.getAllByRole('link', { name: 'Washington/Wabash' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Ashland' }).length).toBeGreaterThan(0);
  });

  it('renders the combined multi-line map for a multi-line incident', async () => {
    render(<EventPage eventId="loopevt" />);
    await waitFor(() => {
      expect(screen.getByText('Loop Elevated Service Delayed')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('img', { name: /Affected stretches across 2 train lines/ }),
    ).toBeInTheDocument();
    // Bot-detected stretches are labeled as observed impact, not "where this
    // happened" — they spread downstream of the CTA's reported epicenter.
    expect(screen.getByText('Bot observed impact')).toBeInTheDocument();
    expect(screen.queryByText('Where this happened')).not.toBeInTheDocument();
  });

  it('fans a bot stretch onto sibling lines that share the trackage', async () => {
    // The bot's pulse-cold was scoped to Pink, but Ashland↔Adams/Wabash also
    // carries Green and the CTA alert names both lines. The station list and
    // map must surface Green alongside Pink — and reframe the copy so the
    // inferred Green rows don't masquerade as separate bot detections.
    render(<EventPage eventId="sharedtrk" />);
    await waitFor(() => {
      expect(
        screen.getByText('Delays near Ashland/Lake Affecting Green and Pink Line Service'),
      ).toBeInTheDocument();
    });
    // Reworded section label (not "Bot observed impacted stations").
    expect(screen.getByText('Affected stations (shared trackage)')).toBeInTheDocument();
    // Both lines now surface (row labels + map legend). Green was entirely
    // absent before the fan-out — its presence is the regression guard.
    expect(screen.getAllByText('Pink').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Green').length).toBeGreaterThan(0);
    // Map heading reframed away from crediting the bot for the Green stretch.
    expect(screen.getByText('Affected stretches')).toBeInTheDocument();
    expect(screen.queryByText('Bot observed impact')).not.toBeInTheDocument();
  });

  it('does not pull in a non-incident line that merely shares the trackage', async () => {
    // Brown-only alert on Belmont↔Fullerton, which Purple also runs. Purple is
    // not in the incident's routes, so it must stay out — the shared-track
    // fan-out only spreads across lines the CTA alert already named.
    render(<EventPage eventId="brnpurple" />);
    await waitFor(() => {
      expect(screen.getByText('Brown Line Delays near Belmont')).toBeInTheDocument();
    });
    // Scope to the event-detail article — the cross-line "Elsewhere on the
    // system" section below it can legitimately mention Purple via unrelated
    // contemporaneous incidents, which isn't what this guard is about.
    const article = within(screen.getByRole('article'));
    // No fan-out happened, so the original (non-shared) framing stays.
    expect(article.queryByText('Affected stations (shared trackage)')).not.toBeInTheDocument();
    // Purple is not pulled into this Brown incident's own footprint.
    expect(article.queryByText('Purple')).not.toBeInTheDocument();
    expect(article.queryByText('Purple Line')).not.toBeInTheDocument();
  });

  it('adds a cleared entry to the Per CTA timeline when the alert resolved', async () => {
    // The Brown Line alert is resolved with CTA body text. The timeline should
    // end on a "cleared" entry (newest) so it doesn't read as still ongoing.
    render(<EventPage eventId="brnriver" />);
    await waitFor(() => {
      expect(screen.getByText('CTA cleared this alert.')).toBeInTheDocument();
    });
    // Original message (1) + clear (1) = 2 updates.
    expect(screen.getByText(/Per CTA · 2 updates/)).toBeInTheDocument();
    // The CTA body text still renders in its version entry.
    expect(screen.getByText(/raised bridge/)).toBeInTheDocument();
  });

  it('adds an onset entry to the Per bot timeline for a back-dated cold start', async () => {
    // pulse-cold posts only after the stretch has been cold a while, so the
    // detection dot lands well after the gap began. With onset_description +
    // onset_ts the rail gains a third entry at the real start.
    render(<EventPage eventId="greenonset" />);
    await waitFor(() => {
      expect(
        screen.getByText(/Last train observed through this stretch around here/),
      ).toBeInTheDocument();
    });
    // onset (1) + detection (1) + clear (1) = 3 updates.
    expect(screen.getByText(/Per bot · 3 updates/)).toBeInTheDocument();
    // The detection entry carries the ALERTED badge (when the bot raised the
    // alarm); the resolution stays the Latest entry.
    expect(screen.getByText('Alerted')).toBeInTheDocument();
    expect(screen.getByText('Latest')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Trains observed again on the Green Line, service appears to be back to normal.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render a station chips row for bus alerts', async () => {
    // affected_from_station / affected_to_station on bus alerts hold
    // cross-street labels, not rail stations — linking them produces
    // /station/wacker pages with no incidents. The chips are suppressed
    // for kind=bus so the broken links never appear.
    render(<EventPage eventId="busreroute" />);
    await waitFor(() => {
      expect(screen.getByText('Temporary Reroute')).toBeInTheDocument();
    });
    expect(screen.queryByText('Stations')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Wacker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Randolph' })).not.toBeInTheDocument();
  });
});
