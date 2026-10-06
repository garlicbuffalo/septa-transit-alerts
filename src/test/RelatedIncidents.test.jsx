import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RelatedIncidents } from '../components/event/RelatedIncidents.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;

// The event whose page we're on — a Rock Island incident so the related list
// (same line, ±24h) picks up the rows below.
const parent = incident({
  id: 'parent',
  kind: 'rail',
  routes: ['ri'],
  first_seen_ts: NOW,
  resolved_ts: NOW,
  active: false,
  cta: null,
  observations: [
    {
      id: 'parent',
      kind: 'rail',
      line: 'ri',
      detection_source: 'delay',
      from_station: 'Joliet',
      to_station: 'LaSalle Street',
      ts: NOW,
      resolved_ts: NOW,
      active: false,
      bot_description: '~20 min late — the 1:25 PM LaSalle Street train',
    },
  ],
});

const inferred = incident({
  id: 'metra-972',
  kind: 'rail',
  routes: ['ri'],
  first_seen_ts: NOW - 60 * 60_000,
  resolved_ts: NOW - 60 * 60_000,
  active: false,
  cta: null,
  observations: [
    {
      id: 'metra-972',
      kind: 'rail',
      line: 'ri',
      detection_source: 'cancellation-inferred',
      from_station: 'LaSalle Street',
      to_station: 'Joliet',
      ts: NOW - 60 * 60_000,
      resolved_ts: NOW - 60 * 60_000,
      active: false,
      bot_description: 'Scheduled train not seen running — the 9:55 AM Joliet train',
    },
  ],
});

// A Metra alert that annuls one scheduled train carries a top-level
// `cancellation` block (state 'cancelled') and renders as a stable train-title.
const cancelled = incident({
  id: 'rid413',
  kind: 'rail',
  routes: ['ri'],
  first_seen_ts: NOW - 30 * 60_000,
  resolved_ts: NOW - 30 * 60_000,
  active: false,
  cancellation: {
    state: 'cancelled',
    scheduled_departure_ts: NOW - 90 * 60_000,
    scheduled_arrival_ts: NOW - 30 * 60_000,
    train_number: '413',
    origin: 'LaSalle Street',
  },
  cta: {
    alert_id: 'a413',
    headline: 'RID #413 Will Not Operate',
    first_seen_ts: NOW - 30 * 60_000,
    post_url: 'https://bsky.app/x',
  },
  observations: [],
});

describe('RelatedIncidents', () => {
  it('titles a bot-only point event with its sentence and shows the badge', () => {
    render(<RelatedIncidents incident={parent} incidents={[parent, inferred]} />);
    // Title matches the event page (the bot sentence), not the bare station pair.
    expect(
      screen.getByText('Scheduled train not seen running — the 9:55 AM Joliet train'),
    ).toBeInTheDocument();
    expect(screen.getByText('possible cancellation')).toBeInTheDocument();
  });

  it('shows a cancelled badge for a single-train Metra cancellation', () => {
    render(<RelatedIncidents incident={parent} incidents={[parent, cancelled]} />);
    expect(screen.getByText('Rock Island train #413 cancelled')).toBeInTheDocument();
    expect(screen.getByText('cancelled')).toBeInTheDocument();
  });
});
