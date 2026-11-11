import '@testing-library/jest-dom';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlannedWorkPage from '../components/PlannedWorkPage.jsx';
import RouteScorecard from '../components/RouteScorecard.jsx';
import ScheduleChangesPage from '../components/ScheduleChangesPage.jsx';
import ScorecardsPage from '../components/ScorecardsPage.jsx';
import { __resetStoreCaches } from '../lib/incidentStore.js';
import { __resetPublishedFiles } from '../lib/publishedFiles.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Wednesday, Nov 11, 2026, noon in Philadelphia.
const NOW = Date.UTC(2026, 10, 11, 17);

function serve(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const hit = Object.entries(files).find(([name]) => String(url).endsWith(name));
      return hit
        ? { ok: true, status: 200, json: async () => hit[1] }
        : { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}
const RECENT = (incidents = []) => ({ schema_version: 2, generated_at: NOW, incidents });

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  __resetPublishedFiles();
  __resetStoreCaches();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const entry = (route, rank, score, over = {}) => ({
  route,
  rank,
  score,
  measures: { onTime: 80, cancelled: 1, speed: 9.5, bunching: 0.4, gaps: 0.1, ...over },
  counts: { cancelled: 3, bunching: 7, gaps: 2 },
});
const SCORECARDS = {
  schema_version: 1,
  generated_at: NOW,
  weights: {
    bus: { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 },
    metro: { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 },
    rail: { onTime: 35, cancelled: 25, delay: 20, speed: 20 },
  },
  on_time: {
    bus: { earlyMin: 1, lateMin: 5 },
    metro: { earlyMin: 1, lateMin: 5 },
    rail: { lateMin: 5 },
  },
  modes: {
    bus: {
      weeks: [{ from: '2026-11-01', to: '2026-11-07', ranked: 2 }],
      latest: {
        from: '2026-11-01',
        to: '2026-11-07',
        ranked: 2,
        entries: [entry('17', 1, 81.4, { speed: 8 }), entry('2', 2, 40, { speed: 12 })],
      },
      history: { 17: [81.4, 70], 2: [40] },
    },
    rail: {
      weeks: [{ from: '2026-11-01', to: '2026-11-07', ranked: 1 }],
      latest: {
        from: '2026-11-01',
        to: '2026-11-07',
        ranked: 1,
        entries: [
          {
            route: 'pao',
            rank: 1,
            score: 55,
            measures: { onTime: 88.2, cancelled: 1.4, delay: 4.2, speed: 31 },
            counts: { cancelled: 9, trains: 640 },
          },
        ],
      },
      history: { pao: [55] },
    },
  },
};
const DAYS = Array.from({ length: 28 }, (_, i) =>
  new Date(Date.UTC(2026, 9, 14 + i)).toISOString().slice(0, 10),
);
const train = (no, late, over = {}) => ({
  no,
  line: 'pao',
  origin: 'Thorndale',
  dest: 'Temple U',
  first_seen_min: 17 * 60 + 10,
  seen: 20,
  ran: 20,
  on_time: 20 - late,
  late,
  cancelled: 0,
  avg_late: 9.5,
  worst: 31,
  daily: DAYS.map((_, i) => (i % 7 > 4 ? null : i < late ? 12 : 1)),
  ...over,
});
const TRAINS = {
  schema_version: 1,
  generated_at: NOW,
  on_time_max: 5,
  from: DAYS[0],
  to: DAYS.at(-1),
  days: DAYS,
  trains: [train('418', 2), train('9531', 15), train('9533', 3, { cancelled: 4 })],
};

describe('the scorecards page', () => {
  it('ranks the routes with their measures, and re-sorts by a column', async () => {
    serve({
      'scorecards.json': SCORECARDS,
      'rail-trains.json': TRAINS,
      'alerts-recent.json': RECENT(),
    });
    render(<ScorecardsPage />);
    const table = await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: 'Buses · week of Nov 1 – 7' })).toBeInTheDocument();
    expect(screen.getByText(/2 routes ranked\. The score weighs on time 30%/)).toBeInTheDocument();
    const rows = () => within(table).getAllByRole('row').slice(1);
    expect(rows().map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual([
      expect.stringContaining('Route 17'),
      expect.stringContaining('Route 2'),
    ]);
    // Score, change from last week, and the measures as counted.
    expect(within(rows()[0]).getByText('81')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('▲ 11')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('new')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('8.0')).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: /Mph/ }));
    expect(within(rows()[0]).getAllByRole('cell')[1]).toHaveTextContent('Route 2');
  });

  it('opens on Regional Rail for a link to a train, and shows its record', async () => {
    window.history.replaceState(null, '', '/scorecards?train=9531');
    serve({
      'scorecards.json': SCORECARDS,
      'rail-trains.json': TRAINS,
      'alerts-recent.json': RECENT(),
    });
    render(<ScorecardsPage />);
    expect(await screen.findByText('Train #9531')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regional Rail' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText("Usually first on SEPTA's tracker around 5:10 PM."),
    ).toBeInTheDocument();
    expect(screen.getByText('(75%)')).toBeInTheDocument();
    // The lists: late most often, and cancelled most often.
    const late = screen
      .getByRole('heading', { name: 'Late most often' })
      .closest('div').parentElement;
    expect(within(late).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(within(late).getByText('15 of 20 days')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cancelled most often' })).toBeInTheDocument();
    expect(window.location.search).toBe('?train=9531&mode=rail');
  });

  it('looks a train up by number', async () => {
    window.history.replaceState(null, '', '/scorecards?mode=rail');
    serve({
      'scorecards.json': SCORECARDS,
      'rail-trains.json': TRAINS,
      'alerts-recent.json': RECENT(),
    });
    render(<ScorecardsPage />);
    const box = await screen.findByLabelText('Look up a train number');
    await userEvent.type(box, '95');
    const matches = screen.getByRole('list', { name: 'Matching trains' });
    expect(
      within(matches)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['#9531', '#9533']);
    await userEvent.click(within(matches).getByRole('button', { name: '#9533' }));
    expect(screen.getByText('Train #9533')).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, '777');
    expect(screen.getByRole('status')).toHaveTextContent('No train #777');
  });

  it("says so when the bot server's files aren't there", async () => {
    serve({ 'alerts-recent.json': RECENT() });
    render(<ScorecardsPage />);
    expect(await screen.findByText(/No week has been scored for Buses yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Regional Rail' }));
    expect(screen.getByText(/train-by-train record isn't available/)).toBeInTheDocument();
  });
});

describe("a route's scorecard strip", () => {
  it('shows the score, rank and measures, or nothing for a route that was not ranked', async () => {
    serve({ 'scorecards.json': SCORECARDS });
    const { container, unmount } = render(<RouteScorecard mode="bus" route="17" />);
    expect(await screen.findByText('Scorecard · week of Nov 1 – 7')).toBeInTheDocument();
    expect(container).toHaveTextContent('81 / 100');
    expect(container).toHaveTextContent('1 of 2');
    expect(screen.getByRole('link', { name: 'All routes →' })).toHaveAttribute(
      'href',
      '/scorecards',
    );
    unmount();
    const other = render(<RouteScorecard mode="metro" route="b1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(other.container).toBeEmptyDOMElement();
  });
});

const planned = ({ id, mode = 'metro', routes = ['l1'], headline, start, end }) => ({
  id,
  agency: 'septa',
  mode,
  routes,
  sources: ['septa'],
  lifecycle: { first_seen_ts: NOW - 3 * DAY, resolved_ts: null, active: true, duration_ms: null },
  official_alert: {
    id,
    headline,
    description: null,
    lifecycle: { first_seen_ts: NOW - 3 * DAY, resolved_ts: null, active: true },
    scope: { stations: [] },
    septa: { type: 'ADVISORY', cause: null, effect: 'MODIFIED_SERVICE' },
    agency_event_window: {
      start_ts: start,
      end_ts: end,
      start_is_date_only: false,
      end_is_date_only: true,
    },
  },
  detections: [],
  status: null,
});
const SATURDAY = Date.UTC(2026, 10, 14, 5);
const SCHEDULE = {
  schema_version: 1,
  generated_at: NOW,
  covers: ['bus', 'metro'],
  feed_version: 'v202611010',
  feed_start: '2026-11-01',
  feed_end: '2027-02-20',
  periods: [],
  changes: [
    {
      id: '2026-12-20',
      effective: '2026-12-20',
      totals: { weekday: [14904, 14778], saturday: [10205, 10097], sunday: [8369, 8287] },
      routes: [
        {
          route: 'M1-Bus',
          mode: 'bus',
          kind: 'ended',
          delta: -818,
          days: { weekday: { trips: [126, 0], first: [16080, null], last: [93960, null] } },
        },
        {
          route: 'b2',
          mode: 'metro',
          kind: 'changed',
          delta: -2,
          days: { sunday: { trips: [2, 0], first: [66000, null], last: [66600, null] } },
        },
      ],
    },
  ],
  special_days: [
    {
      date: '2026-11-26',
      day_type: 'weekday',
      holiday: 'Thanksgiving',
      trips: 8437,
      typical: 14904,
      like: 'sunday',
      kind: 'reduced',
      routes_off: ['1', '8'],
    },
  ],
};

describe('the planned work page', () => {
  const incidents = [
    planned({
      id: 'alert-1',
      headline: 'Shuttle buses replace trains between 15th St and 69th St',
      start: SATURDAY + 5 * HOUR,
      end: SATURDAY + 2 * DAY - 60_000,
    }),
    planned({
      id: 'alert-2',
      mode: 'regional_rail',
      routes: ['pao'],
      headline: 'Buses replace trains between Malvern and Thorndale',
      start: NOW - 2 * DAY,
      end: NOW + DAY,
    }),
  ];

  it('lays the work out by the weekend, the days ahead, and now', async () => {
    serve({ 'alerts-recent.json': RECENT(incidents), 'schedule-changes.json': SCHEDULE });
    render(<PlannedWorkPage />);
    const weekend = await screen.findByRole('region', { name: /^This weekend · Nov 14 – Nov 15/ });
    expect(
      within(weekend).getByText('Shuttle buses replace trains between 15th St and 69th St'),
    ).toBeInTheDocument();
    expect(within(weekend).getByText('Starts this weekend')).toBeInTheDocument();
    expect(within(weekend).getByText('Sat, Nov 14, 5:00 AM – Sun, Nov 15')).toBeInTheDocument();
    const now = screen.getByRole('region', { name: 'In effect now (1)' });
    expect(within(now).getByRole('link', { name: /Malvern and Thorndale/ })).toHaveAttribute(
      'href',
      '/event/alert-2',
    );
    expect(within(now).getByText('Until Thu, Nov 12')).toBeInTheDocument();
    const starting = screen.getByRole('region', { name: 'Starting in the next 7 days' });
    expect(within(starting).getByRole('heading', { name: 'Sat, Nov 14' })).toBeInTheDocument();
  });

  it('narrows to a mode, and keeps the choice in the URL', async () => {
    serve({ 'alerts-recent.json': RECENT(incidents), 'schedule-changes.json': SCHEDULE });
    render(<PlannedWorkPage />);
    await screen.findByRole('region', { name: 'In effect now (1)' });
    await userEvent.click(screen.getByRole('button', { name: 'Regional Rail' }));
    expect(screen.queryByText(/15th St and 69th St/)).not.toBeInTheDocument();
    expect(screen.getByText('Nothing planned covers this weekend.')).toBeInTheDocument();
    expect(window.location.search).toBe('?mode=rail');
  });

  it('says so when nothing is planned', async () => {
    serve({ 'alerts-recent.json': RECENT([]) });
    render(<PlannedWorkPage />);
    expect(
      await screen.findByText('SEPTA has no planned work posted right now.'),
    ).toBeInTheDocument();
  });
});

describe('the schedule changes page', () => {
  it('lists the special days and each change set, route by route', async () => {
    serve({ 'schedule-changes.json': SCHEDULE, 'alerts-recent.json': RECENT() });
    render(<ScheduleChangesPage />);
    expect(await screen.findByText('Thu, Nov 26 · Thanksgiving')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Buses and Metro run a Sunday timetable: 8,437 trips, 57% of a usual Thursday.',
      ),
    ).toBeInTheDocument();
    const set = screen.getByRole('region', { name: 'Changes from Sunday, December 20, 2026' });
    expect(within(set).getByText('in 39 days')).toBeInTheDocument();
    expect(
      within(set).getByText(/2 routes change · 2 with fewer trips · 1 no longer scheduled/),
    ).toBeInTheDocument();
    expect(within(set).getByText('14,904 → 14,778')).toBeInTheDocument();
    expect(within(set).getByText('(−0.8%)')).toBeInTheDocument();
    const rows = within(set).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('no service (was 126)')).toBeInTheDocument();
    expect(within(rows[0]).getByText('No longer scheduled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'SEPTA Metro' }));
    expect(within(set).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(screen.getByText(/Buses and SEPTA Metro only\./)).toBeInTheDocument();
  });

  it('says so when there is no file, and when nothing has changed yet', async () => {
    serve({ 'alerts-recent.json': RECENT() });
    const first = render(<ScheduleChangesPage />);
    expect(
      await screen.findByText(/Schedule changes aren't available right now/),
    ).toBeInTheDocument();
    first.unmount();
    __resetPublishedFiles();
    serve({
      'schedule-changes.json': { ...SCHEDULE, changes: [], special_days: [] },
      'alerts-recent.json': RECENT(),
    });
    render(<ScheduleChangesPage />);
    expect(await screen.findByText(/No timetable change is on record yet/)).toBeInTheDocument();
    expect(
      screen.getByText('Every day in the next four weeks runs its usual timetable.'),
    ).toBeInTheDocument();
  });
});
