import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import IncidentList from '../components/IncidentList.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;

// Nested incident wire shape: top-level id/kind/routes, a nullable `cta` block,
// and an `observations[]` list.
const obsRecord = (over = {}) => ({
  id: 1,
  kind: 'metro',
  line: 'l1',
  from_station: 'Spring Garden',
  to_station: 'York-Dauphin',
  ts: NOW - 55 * 60_000,
  resolved_ts: NOW - 30 * 60_000,
  active: false,
  post_url: 'https://bsky.app/obs',
  ...over,
});

const alertInc = (over = {}) =>
  incident({
    id: 'alert1',
    kind: 'metro',
    routes: ['l1'],
    first_seen_ts: NOW - 60 * 60_000,
    resolved_ts: NOW - 30 * 60_000,
    active: false,
    cta: {
      alert_id: 'a1',
      headline: 'L1 Delays',
      post_url: 'https://bsky.app/alert',
      first_seen_ts: NOW - 60 * 60_000,
    },
    observations: [],
    ...over,
  });

const obsInc = (over = {}) =>
  incident({
    id: 'obs1',
    kind: 'metro',
    routes: ['l1'],
    first_seen_ts: NOW - 55 * 60_000,
    resolved_ts: NOW - 30 * 60_000,
    active: false,
    cta: null,
    observations: [obsRecord()],
    ...over,
  });

const mergedInc = (over = {}) =>
  incident({
    id: 'm1',
    kind: 'metro',
    routes: ['l1'],
    first_seen_ts: NOW - 60 * 60_000,
    resolved_ts: NOW - 30 * 60_000,
    active: false,
    cta: {
      alert_id: 'a1',
      headline: 'L1 Delays',
      post_url: 'https://bsky.app/alert',
      first_seen_ts: NOW - 60 * 60_000,
    },
    observations: [obsRecord()],
    ...over,
  });

describe('IncidentList', () => {
  it('shows empty state when there are no incidents', () => {
    render(<IncidentList incidents={[]} />);
    expect(screen.getByText(/no incidents/i)).toBeInTheDocument();
  });

  it('shows "via SEPTA" tag for SEPTA-only incidents', () => {
    render(<IncidentList incidents={[alertInc()]} />);
    expect(screen.getByText('via SEPTA')).toBeInTheDocument();
  });

  it('shows "via auto-detection" tag for bot-only incidents', () => {
    render(<IncidentList incidents={[obsInc()]} />);
    expect(screen.getByText('via auto-detection')).toBeInTheDocument();
  });

  it('shows both tags for a merged incident', () => {
    render(<IncidentList incidents={[mergedInc()]} />);
    expect(screen.getByText('via SEPTA')).toBeInTheDocument();
    expect(screen.getByText('via auto-detection')).toBeInTheDocument();
  });

  it('shows both source links for a merged incident', () => {
    render(<IncidentList incidents={[mergedInc()]} />);
    expect(screen.getByText('Alert on Bluesky →')).toBeInTheDocument();
    expect(screen.getByText('Bot detection (gap) →')).toBeInTheDocument();
  });

  it('shows the station segment for a merged incident', () => {
    render(<IncidentList incidents={[mergedInc()]} />);
    expect(screen.getByText('Spring Garden')).toBeInTheDocument();
    expect(screen.getByText('York-Dauphin')).toBeInTheDocument();
  });

  it('shows the affected station segment as a subtitle for a pure official train alert', () => {
    const seg = alertInc({
      cta: {
        alert_id: 'a1',
        headline: 'L1 reroute',
        post_url: 'https://bsky.app/alert',
        first_seen_ts: NOW - 60 * 60_000,
        from_station: 'Frankford Transit Center',
        to_station: 'York-Dauphin',
      },
    });
    render(<IncidentList incidents={[seg]} />);
    expect(screen.getByText('Frankford Transit Center')).toBeInTheDocument();
    expect(screen.getByText('York-Dauphin')).toBeInTheDocument();
  });

  it('shows "ongoing" badge for active incidents', () => {
    render(<IncidentList incidents={[alertInc({ resolved_ts: null, active: true })]} />);
    expect(screen.getByText('ongoing')).toBeInTheDocument();
  });

  it('keeps plain durations in the metadata line, not the right-side badge column', () => {
    const { container } = render(<IncidentList incidents={[obsInc()]} />);
    expect(screen.getByText('~25m duration')).toBeInTheDocument();
    const rightBadgeColumn = container.querySelector('.flex-shrink-0.text-right.whitespace-nowrap');
    expect(rightBadgeColumn).toBeNull();
  });

  it('shows a "delayed" badge and leads with the train number for a Regional Rail delay', () => {
    const delayInc = incident({
      id: 'delay-992',
      kind: 'rail',
      routes: ['pao'],
      first_seen_ts: NOW,
      resolved_ts: NOW,
      active: false,
      cta: null,
      observations: [
        {
          id: 'delay-992',
          kind: 'rail',
          line: 'pao',
          train_number: '121',
          from_station: 'Thorndale',
          to_station: 'Suburban Station',
          detection_source: 'delay',
          ts: NOW,
          resolved_ts: NOW,
          active: false,
          bot_description: '~57 min late — the 12:05 PM Thorndale train',
        },
      ],
    });
    render(<IncidentList incidents={[delayInc]} />);
    expect(screen.getByText('delayed')).toBeInTheDocument();
    expect(screen.getByText('Paoli/Thorndale Line train #121 delayed')).toBeInTheDocument();
    // The affected stretch moves to the secondary line.
    expect(screen.getByText('Thorndale')).toBeInTheDocument();
    expect(screen.getByText('Suburban Station')).toBeInTheDocument();
  });

  it('shows a "possible cancellation" badge for an inferred Regional Rail cancellation', () => {
    const inferredInc = incident({
      id: 'cancel-972',
      kind: 'rail',
      routes: ['lan'],
      first_seen_ts: NOW,
      resolved_ts: NOW,
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
          ts: NOW,
          resolved_ts: NOW,
          active: false,
          bot_description: 'Scheduled train not seen running — the 9:55 AM Doylestown train',
        },
      ],
    });
    render(<IncidentList incidents={[inferredInc]} />);
    expect(screen.getByText('possible cancellation')).toBeInTheDocument();
    expect(
      screen.getByText('Scheduled train not seen running — the 9:55 AM Doylestown train'),
    ).toBeInTheDocument();
    expect(screen.getByText('Suburban Station')).toBeInTheDocument();
    expect(screen.getByText('Doylestown')).toBeInTheDocument();
  });

  it('shows the canceled-trips count as an evidence chip for a cancellation surge', () => {
    const cancelSurge = incident({
      id: 'cancel-surge-9',
      kind: 'bus',
      routes: ['9'],
      first_seen_ts: NOW,
      resolved_ts: NOW,
      active: false,
      cta: null,
      observations: [
        {
          id: 'roundup-9',
          kind: 'bus',
          line: '9',
          detection_source: 'roundup',
          ts: NOW,
          resolved_ts: NOW,
          active: false,
          bot_description: 'Route 9 service signals',
          signals: ['cancellation'],
          evidence: { signals: ['cancellation'] },
          bot_evidence_bullets: ['8 of 14 scheduled trips canceled this past hour'],
        },
      ],
    });
    render(<IncidentList incidents={[cancelSurge]} />);
    expect(screen.getByText('8 of 14 scheduled trips canceled this past hour')).toBeInTheDocument();
  });

  it('shows load more button when incidents exceed page size', () => {
    const incidents = Array.from({ length: 26 }, (_, i) =>
      alertInc({ id: `a${i + 1}`, first_seen_ts: NOW - (i + 1) * 60_000 }),
    );
    render(<IncidentList incidents={incidents} />);
    expect(screen.getByText(/load more/i)).toBeInTheDocument();
  });

  it('loads more incidents when load more is clicked', async () => {
    const incidents = Array.from({ length: 26 }, (_, i) =>
      alertInc({ id: `a${i + 1}`, first_seen_ts: NOW - (i + 1) * 60_000 }),
    );
    render(<IncidentList incidents={incidents} />);
    await userEvent.click(screen.getByText(/load more/i));
    expect(screen.queryByText(/load more/i)).not.toBeInTheDocument();
  });
});
