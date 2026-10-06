import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EventNav from '../components/event/EventNav.jsx';
import { incident } from './v2TestHelpers.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// Three B1 incidents + one L1, so the subject (middle B1) has a
// same-line prev and a global prev/next that differ.
const incidents = [
  incident({ id: 'older-blue', kind: 'metro', routes: ['b1'], first_seen_ts: NOW - 3 * HOUR }),
  incident({ id: 'red-between', kind: 'metro', routes: ['l1'], first_seen_ts: NOW - 2 * HOUR }),
  incident({ id: 'subject', kind: 'metro', routes: ['b1'], first_seen_ts: NOW - 1 * HOUR }),
  incident({ id: 'newest', kind: 'metro', routes: ['t1'], first_seen_ts: NOW }),
];

describe('EventNav', () => {
  it('renders same-line and global rows with Previous/Next captions', () => {
    render(<EventNav incident={incidents[2]} incidents={incidents} />);

    // Directional cue is a caption, not an arrow glued to the title.
    expect(screen.getAllByText('← Previous').length).toBeGreaterThan(0);

    // "See all →" links to the single line's page.
    const seeAll = screen.getByRole('link', { name: /see all/i });
    expect(seeAll.getAttribute('href')).toBe('/line/b1');

    // Same-line previous skips the L1 incident and points at the older B1.
    const onLine = screen.getByText('On B1 Broad Street Line').closest('div').parentElement;
    const bluePrev = within(onLine).getByText('← Previous').closest('a');
    expect(bluePrev.getAttribute('href')).toBe('/event/older-blue');
  });

  it('renders nothing when the subject is not in the list', () => {
    const { container } = render(
      <EventNav
        incident={incident({ id: 'ghost', kind: 'metro', routes: ['b1'] })}
        incidents={incidents}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
