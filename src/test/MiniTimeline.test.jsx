import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MiniTimeline } from '../components/event/MiniTimeline.jsx';
import { incident as v2Incident } from './v2TestHelpers.js';

// Build an incident + a sibling incident on the same day so the centered
// window has at least one populated (linkable) cell.
function fixture(kind, routes) {
  const ts = Date.now() - 60 * 60 * 1000; // an hour ago, safely inside the window
  const incident = v2Incident({ id: 'evt', kind, routes, first_seen_ts: ts, cta: null });
  // A second incident on the same line/day guarantees a count>0 cell to link.
  const sibling = v2Incident({ id: 'sib', kind, routes, first_seen_ts: ts, cta: null });
  return { incident, incidents: [incident, sibling] };
}

describe('MiniTimeline day links', () => {
  it('scopes a Metro day link to the line via ?lines=<line>', () => {
    const { incident, incidents } = fixture('metro', ['g1']);
    render(<MiniTimeline incident={incident} incidents={incidents} dark={false} />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^\/day\/\d{4}-\d{2}-\d{2}\?lines=g1$/);
    }
  });

  it('scopes a bus day link to the route via ?lines=none&routes=<route>', () => {
    // Alphanumeric route id round-trips through the same query scheme.
    const { incident, incidents } = fixture('bus', ['X9']);
    render(<MiniTimeline incident={incident} incidents={incidents} dark={false} />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^\/day\/\d{4}-\d{2}-\d{2}\?lines=none&routes=X9$/);
    }
  });

  it('does not linkify empty days', () => {
    // A line with no incidents in the window renders only inert cells.
    const incident = v2Incident({
      id: 'evt',
      kind: 'metro',
      routes: ['d1'],
      first_seen_ts: Date.now(),
      cta: null,
    });
    render(<MiniTimeline incident={incident} incidents={[incident]} dark={false} />);
    // The single self-incident day is linkable; every other cell is inert.
    const links = screen.queryAllByRole('link');
    expect(links.length).toBe(1);
  });
});
