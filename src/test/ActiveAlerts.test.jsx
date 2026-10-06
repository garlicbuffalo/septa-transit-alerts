import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ActiveAlerts from '../components/ActiveAlerts.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

// Nested incident shape with a SEPTA block — ActiveCard shows `cta.headline`
// directly, so the headline doubles as a stable text handle in assertions.
const activeInc = (over = {}) =>
  incident({
    id: 'a1',
    kind: 'metro',
    routes: ['l1'],
    active: true,
    first_seen_ts: NOW - 20 * MIN,
    resolved_ts: null,
    cta: {
      alert_id: 'x',
      headline: 'Red Line Delays',
      post_url: 'https://bsky.app/profile/x/post/a1',
      first_seen_ts: NOW - 20 * MIN,
    },
    observations: [],
    ...over,
  });

describe('ActiveAlerts', () => {
  it('renders the "Active Now" heading with the combined active + long-running count', () => {
    render(
      <ActiveAlerts
        incidents={[activeInc({ id: 'a1' })]}
        longRunningIncidents={[activeInc({ id: 'lr1', first_seen_ts: NOW - 3 * 24 * 60 * MIN })]}
        now={NOW}
        typicalDurations={null}
        stationIndex={null}
      />,
    );
    // 1 active + 1 long-running, merged and re-bucketed by category. Scope to
    // the section's h2 — sub-section labels (h3) also carry counts.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Active Now\s*\(2\)/);
  });

  it('buckets active incidents into Disruptions, Delays, and Planned sections', () => {
    render(
      <ActiveAlerts
        incidents={[
          // Live disruption (SEPTA train).
          activeInc({
            id: 'd1',
            cta: { headline: 'Red Line gap', post_url: 'https://bsky.app/profile/x/post/d1' },
          }),
          // Routine Regional Rail delay → Delays.
          activeInc({
            id: 'dl1',
            kind: 'rail',
            routes: ['pao'],
            rail_status: { source: 'delay' },
            cta: { headline: 'BNSF 1282 delayed', post_url: 'https://bsky.app/profile/x/post/dl1' },
          }),
          // Planned track construction → Planned & scheduled.
          activeInc({
            id: 'p1',
            kind: 'rail',
            routes: ['nor'],
            rail_status: { source: 'planned-delay' },
            cta: {
              headline: 'Track Construction Sat Jun 13',
              post_url: 'https://bsky.app/profile/x/post/p1',
            },
          }),
        ]}
        now={NOW}
        typicalDurations={null}
        stationIndex={null}
      />,
    );
    expect(screen.getByText(/^Disruptions$/)).toBeInTheDocument();
    expect(screen.getByText(/^Delays$/)).toBeInTheDocument();
    expect(screen.getByText(/Planned & scheduled/)).toBeInTheDocument();
    expect(screen.getByText('Red Line gap')).toBeInTheDocument();
    expect(screen.getByText('BNSF 1282 delayed')).toBeInTheDocument();
    expect(screen.getByText('Track Construction Sat Jun 13')).toBeInTheDocument();
  });

  it('keeps the first two incidents as full cards and collapses the rest to compact rows', () => {
    render(
      <ActiveAlerts
        incidents={[
          activeInc({
            id: 'a1',
            cta: { headline: 'First', post_url: 'https://bsky.app/profile/x/post/a1' },
          }),
          activeInc({
            id: 'a2',
            cta: { headline: 'Second', post_url: 'https://bsky.app/profile/x/post/a2' },
          }),
          activeInc({
            id: 'a3',
            cta: { headline: 'Third', post_url: 'https://bsky.app/profile/x/post/a3' },
          }),
        ]}
        now={NOW}
        typicalDurations={null}
        stationIndex={null}
      />,
    );
    // All three are present somewhere in the section.
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
    // Only full cards carry a Share/Copy link, so exactly two appear.
    expect(screen.getAllByText(/share|copy link/i)).toHaveLength(2);
    // The collapsed row still links straight to the event permalink.
    expect(document.querySelector('a[href="/event/a3"]')).not.toBeNull();
  });

  it('shows the burst chip only when the recent rate clears the threshold', () => {
    const { rerender } = render(
      <ActiveAlerts
        incidents={[activeInc()]}
        now={NOW}
        typicalDurations={null}
        stationIndex={null}
        burst={{ recentCount: 4, windowHours: 3, ratio: 2.5 }}
      />,
    );
    expect(screen.getByText(/4 in 3h · 2\.5× typical rate/)).toBeInTheDocument();

    // Below the ratio threshold (2×) → no chip.
    rerender(
      <ActiveAlerts
        incidents={[activeInc()]}
        now={NOW}
        typicalDurations={null}
        stationIndex={null}
        burst={{ recentCount: 4, windowHours: 3, ratio: 1.2 }}
      />,
    );
    expect(screen.queryByText(/typical rate/)).not.toBeInTheDocument();
  });
});
