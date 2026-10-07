import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SystemDashboard from '../components/health/SystemDashboard.jsx';
import { incident } from './v2TestHelpers.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const incidents = [
  incident({
    id: 'g1',
    kind: 'metro',
    routes: ['l1'],
    cta: null,
    active: true,
    first_seen_ts: NOW - 20 * MIN,
    observations: [{ detection_source: 'gap', line: 'l1' }],
  }),
  incident({
    id: 'r1',
    kind: 'rail',
    routes: ['pao'],
    cta: null,
    active: true,
    first_seen_ts: NOW - 40 * MIN,
    observations: [{ detection_source: 'delay', line: 'pao' }],
  }),
];

describe('SystemDashboard', () => {
  it('renders one health tile per mode in the All view', () => {
    render(<SystemDashboard incidents={incidents} network="all" now={NOW} />);
    const tiles = screen.getAllByRole('article');
    expect(tiles.map((t) => within(t).getByRole('heading').textContent)).toEqual([
      'SEPTA Metro',
      'Bus',
      'Regional Rail',
    ]);
    expect(within(tiles[0]).getByText('Disruptions', { selector: 'span' })).toBeInTheDocument();
    expect(within(tiles[1]).getByText('Good service')).toBeInTheDocument();
  });

  it('scopes tiles to the selected network', () => {
    render(<SystemDashboard incidents={incidents} network="rail" now={NOW} />);
    const tiles = screen.getAllByRole('article');
    expect(tiles).toHaveLength(1);
    expect(within(tiles[0]).getByRole('heading').textContent).toBe('Regional Rail');
  });

  it('labels each line on the board with its status and links to its page', () => {
    render(<SystemDashboard incidents={incidents} network="all" now={NOW} />);
    const l1 = screen.getByRole('link', { name: /Market-Frankford Line: 1 disruption$/ });
    expect(l1).toHaveAttribute('href', '/line/l1');
    expect(screen.getByRole('link', { name: /Broad Street Line: good service/ })).toBeTruthy();
  });

  it('shows a tooltip for the focused column via the keyboard', () => {
    render(<SystemDashboard incidents={incidents} network="transit" now={NOW} />);
    const plot = screen.getByRole('img', { name: /SEPTA Metro incidents per hour/ });
    fireEvent.keyDown(plot, { key: 'End' });
    expect(screen.getByRole('tooltip')).toHaveTextContent(/– now/);
    // The L1 gap started 20 minutes ago, in the previous clock hour.
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('1 new unplanned incident');
    fireEvent.blur(plot);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('charts most-affected lines and issue types', () => {
    render(<SystemDashboard incidents={incidents} network="all" now={NOW} />);
    expect(screen.getByText('Headway gaps')).toBeInTheDocument();
    expect(screen.getByText('Late trains')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /^L1 \(SEPTA Metro\): 1 in the last 24 hours/ }),
    ).toHaveAttribute('href', '/line/l1');
  });
});
