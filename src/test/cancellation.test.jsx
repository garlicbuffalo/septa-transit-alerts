import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import IncidentList from '../components/IncidentList.jsx';
import RailUpcomingCancellations from '../components/RailUpcomingCancellations.jsx';
import {
  cancellationInfo,
  cancellationSchedulePhrase,
  cancellationStatusLabel,
  collectUpcomingCancellations,
} from '../lib/cancellation.js';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;

const cancelInc = (cancellation, over = {}) =>
  incident({
    id: 'metra1',
    kind: 'rail',
    routes: ['UP-W'],
    first_seen_ts: NOW - 20 * 60_000,
    resolved_ts: cancellation.state === 'cancelled' ? NOW - 10 * 60_000 : null,
    active: cancellation.state !== 'cancelled',
    cancellation,
    cta: {
      alert_id: 'm-a1',
      headline: 'UPW train #67 will not operate',
      post_url: 'https://bsky.app/alert',
      first_seen_ts: NOW - 20 * 60_000,
    },
    observations: [],
    ...over,
  });

const UPCOMING = {
  state: 'upcoming',
  scheduled_departure_ts: NOW + 60 * 60_000,
  scheduled_arrival_ts: NOW + 148 * 60_000,
  train_number: '67',
  origin: 'Jefferson Station',
};
// A finalized cancellation: its scheduled departure is in the PAST relative to
// NOW, which is what now makes it read as 'cancelled' (the state is re-derived
// from the departure time, not trusted from the server stamp).
const CANCELLED = {
  ...UPCOMING,
  state: 'cancelled',
  scheduled_departure_ts: NOW - 60 * 60_000,
  scheduled_arrival_ts: NOW - 5 * 60_000,
};

describe('cancellation helpers', () => {
  it('returns null for an incident with no cancellation block', () => {
    expect(cancellationInfo(incident({ kind: 'rail', cta: { headline: 'x' } }))).toBeNull();
    expect(cancellationInfo(incident({ kind: 'rail', cta: null }))).toBeNull();
    expect(cancellationInfo(undefined)).toBeNull();
  });

  it('normalizes the cancellation block', () => {
    const info = cancellationInfo(cancelInc(UPCOMING), NOW);
    expect(info.isUpcoming).toBe(true);
    expect(info.isCancelled).toBe(false);
    expect(info.trainNumber).toBe('67');
    expect(info.origin).toBe('Jefferson Station');
  });

  it('re-derives cancelled once the departure passes, ignoring a stale upcoming state', () => {
    // The producer stamped 'upcoming' at export time; the wall clock has since
    // crossed the scheduled departure. The label must flip without waiting for
    // the next export.
    const info = cancellationInfo(cancelInc(UPCOMING), UPCOMING.scheduled_departure_ts + 60_000);
    expect(info.isCancelled).toBe(true);
    expect(info.isUpcoming).toBe(false);
    expect(info.state).toBe('cancelled');
  });

  it('labels each state', () => {
    expect(cancellationStatusLabel(cancellationInfo(cancelInc(UPCOMING), NOW))).toBe(
      'upcoming cancellation',
    );
    expect(cancellationStatusLabel(cancellationInfo(cancelInc(CANCELLED), NOW))).toBe('cancelled');
    expect(cancellationStatusLabel(null)).toBeNull();
  });

  it('builds the schedule phrase (full run, departure-only, none)', () => {
    expect(cancellationSchedulePhrase(cancellationInfo(cancelInc(UPCOMING), NOW))).toMatch(/→/);
    const depOnly = cancellationInfo(cancelInc({ ...UPCOMING, scheduled_arrival_ts: null }), NOW);
    expect(cancellationSchedulePhrase(depOnly)).toMatch(/departure$/);
    const noTimes = cancellationInfo(cancelInc({ ...UPCOMING, scheduled_departure_ts: null }), NOW);
    expect(cancellationSchedulePhrase(noTimes)).toBeNull();
  });
});

describe('IncidentList cancellation rendering', () => {
  it('shows an "upcoming cancellation" badge, not "ongoing", for an upcoming cancellation', () => {
    // IncidentList reads the badge against the real clock (no injected now), so
    // the departure must be genuinely ahead of it to read as upcoming.
    const futureDep = Date.now() + 60 * 60_000;
    const upcomingInc = cancelInc({
      ...UPCOMING,
      scheduled_departure_ts: futureDep,
      scheduled_arrival_ts: futureDep + 88 * 60_000,
    });
    render(<IncidentList incidents={[upcomingInc]} />);
    expect(screen.getByText('upcoming cancellation')).toBeInTheDocument();
    expect(screen.queryByText('ongoing')).not.toBeInTheDocument();
  });

  it('shows a "cancelled" badge, not "resolved" or a duration, for a finalized cancellation', () => {
    render(<IncidentList incidents={[cancelInc(CANCELLED)]} />);
    expect(screen.getByText('cancelled')).toBeInTheDocument();
    expect(screen.queryByText(/duration/i)).not.toBeInTheDocument();
  });
});

describe('collectUpcomingCancellations', () => {
  const other = incident({
    id: 'x',
    kind: 'rail',
    routes: ['wil'],
    cta: { headline: 'Signal problems' },
  });

  it('returns only upcoming cancellations whose departure is still ahead, soonest first', () => {
    const soon = cancelInc(
      { ...UPCOMING, scheduled_departure_ts: NOW + 30 * 60_000 },
      { id: 'soon' },
    );
    const later = cancelInc(
      { ...UPCOMING, scheduled_departure_ts: NOW + 90 * 60_000 },
      { id: 'later' },
    );
    const past = cancelInc(
      { ...UPCOMING, scheduled_departure_ts: NOW - 5 * 60_000 },
      { id: 'past' },
    );
    const done = cancelInc(CANCELLED, { id: 'done' });
    const got = collectUpcomingCancellations([later, done, soon, past, other], { now: NOW });
    expect(got.map((g) => g.id)).toEqual(['soon', 'later']); // past + cancelled + non-cancel dropped
    expect(got[0].trainNumber).toBe('67');
  });

  it('is empty when there are no upcoming cancellations', () => {
    expect(collectUpcomingCancellations([other, cancelInc(CANCELLED)], { now: NOW })).toEqual([]);
  });
});

describe('RailUpcomingCancellations', () => {
  it('renders nothing when there are no upcoming cancellations', () => {
    const { container } = render(
      <RailUpcomingCancellations incidents={[cancelInc(CANCELLED)]} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists upcoming cancellations with a count, train number, and origin', () => {
    render(<RailUpcomingCancellations incidents={[cancelInc(UPCOMING)]} now={NOW} />);
    expect(screen.getByText(/1 upcoming cancellation/)).toBeInTheDocument();
    expect(screen.getByText('Train #67')).toBeInTheDocument();
    expect(screen.getByText(/Jefferson Station/)).toBeInTheDocument();
  });
});
