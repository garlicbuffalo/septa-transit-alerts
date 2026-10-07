import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Leaflet is covered in InteractiveMap.test.jsx; here the map is a stand-in that
// shows what it was asked to draw.
vi.mock('../components/InteractiveMap.jsx', () => ({
  default: ({ label, lines, dots, stops, stopZoom, children }) => (
    <div data-testid="map" data-label={label}>
      <span data-testid="lines">{JSON.stringify(lines)}</span>
      <span data-testid="dots">{JSON.stringify(dots ?? [])}</span>
      <span data-testid="stops">{JSON.stringify((stops ?? []).map((s) => s.name))}</span>
      <span data-testid="stop-zoom">{String(stopZoom)}</span>
      {children}
    </div>
  ),
}));
const drawn = (id) => JSON.parse(screen.getByTestId(id).textContent);

import RouteMap from '../components/RouteMap.jsx';
import SpeedMap from '../components/SpeedMap.jsx';

const LINE = [
  [40.0, -75.17],
  [40.01, -75.17],
  [40.02, -75.17],
];
const direction = (over) => ({
  id: '0',
  label: 'Southbound',
  avg_mph: 9.1,
  coverage: 0.75,
  readings: 4000,
  bin_m: 556.6,
  mph: [3.2, null, 12, 22],
  n: [30, 1, 40, 50],
  shape: LINE,
  ...over,
});
const speeds = (directions) => ({
  schema_version: 1,
  mode: 'bus',
  route: '17',
  generated_at: Date.now() - 60_000,
  window_days: 7,
  from_day: '2026-09-30',
  to_day: '2026-10-06',
  days_with_data: 7,
  directions,
});

function serve(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const hit = Object.entries(files).find(([name]) => String(url).endsWith(name));
      return hit
        ? { ok: true, json: async () => hit[1] }
        : { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('SpeedMap', () => {
  it('shows the week’s average, slowest and fastest stretch, and the dates', async () => {
    serve({
      'speeds/17.json': speeds([direction()]),
    });
    render(<SpeedMap route="17" label="Route 17" />);
    expect(await screen.findByText('Average speeds, past 7 days')).toBeInTheDocument();
    expect(screen.getByText('9.1 mph')).toBeInTheDocument();
    expect(screen.getByText('3.2 mph')).toBeInTheDocument();
    expect(screen.getByText('22.0 mph')).toBeInTheDocument();
    expect(screen.getByText('Sep 30 – Oct 6')).toBeInTheDocument();
    expect(screen.getByText(/4,000 position pairs/)).toBeInTheDocument();
    expect(screen.getByText(/averaging 9\.1 mph/)).toBeInTheDocument();
    // The route's gray line, and a colored line (with its mph) for each stretch with data.
    await screen.findByTestId('lines');
    const lines = drawn('lines');
    expect(lines.map((l) => l.id)).toEqual(['base', 0, 2, 3]);
    expect(lines[1].tip).toBe('3.2 mph (30 readings)');
    expect(lines[1].color).not.toBe(lines[0].color);
    // One direction: no toggle.
    expect(screen.queryByRole('button', { name: 'Southbound' })).not.toBeInTheDocument();
  });

  it('switches between directions, starting with the busier one', async () => {
    serve({
      'speeds/17.json': speeds([
        direction({ id: '0', label: 'Southbound', avg_mph: 9.1, readings: 100 }),
        direction({ id: '1', label: 'Northbound', avg_mph: 14.2, readings: 900 }),
      ]),
    });
    render(<SpeedMap route="17" label="Route 17" />);
    expect(await screen.findByText('14.2 mph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Northbound' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Southbound' }));
    expect(screen.getByText('9.1 mph')).toBeInTheDocument();
    expect(screen.getByTestId('map')).toHaveAttribute(
      'data-label',
      'Route 17 southbound average speeds',
    );
  });

  it('draws nothing for a route without speeds', async () => {
    serve({});
    const { container } = render(<SpeedMap route="17" label="Route 17" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SpeedMap stops', () => {
  const shapes = {
    schema_version: 1,
    route: '17',
    directions: { 0: LINE, 1: [...LINE].reverse() },
    stops: {
      0: [
        [40.0, -75.17, 'Front St & Market St'],
        [40.02, -75.17, '20th St & Johnston St'],
      ],
      1: [[40.01, -75.1701, 'Broad St & Spring Garden St']],
    },
  };

  it('gives the map the stops of the direction on show, and swaps them with the toggle', async () => {
    serve({
      'speeds/17.json': speeds([
        direction({ id: '0', label: 'Southbound', readings: 900 }),
        direction({ id: '1', label: 'Northbound', readings: 100 }),
      ]),
      'shapes/17.json': shapes,
    });
    render(<SpeedMap route="17" label="Route 17" />);
    await screen.findByTestId('stops');
    await waitFor(() =>
      expect(drawn('stops')).toEqual(['Front St & Market St', '20th St & Johnston St']),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Northbound' }));
    expect(drawn('stops')).toEqual(['Broad St & Spring Garden St']);
    // The map's own default for when stops appear.
    expect(screen.getByTestId('stop-zoom')).toHaveTextContent('undefined');
  });

  it('still draws the speeds when the route has no published stops', async () => {
    serve({ 'speeds/17.json': speeds([direction()]) });
    render(<SpeedMap route="17" label="Route 17" />);
    await screen.findByTestId('lines');
    expect(drawn('stops')).toEqual([]);
  });
});

describe('SpeedMap for Regional Rail', () => {
  it('reads the line’s file under speeds/rail/ and uses the rail speed bands', async () => {
    serve({
      'speeds/rail/pao.json': {
        ...speeds([
          direction({ label: 'Both directions', avg_mph: 38.4, mph: [12, null, 41, 52] }),
        ]),
        mode: 'regional_rail',
        route: 'pao',
      },
    });
    render(<SpeedMap route="pao" label="Paoli/Thorndale Line" mode="rail" />);
    expect(await screen.findByText('38.4 mph')).toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toMatch(/speeds\/rail\/pao\.json$/);
    expect(screen.getByText('45+ mph')).toBeInTheDocument();
    expect(screen.getByText('35–45')).toBeInTheDocument();
    expect(screen.getByText('Both directions')).toBeInTheDocument();
    expect(screen.getByText(/TrainView/)).toBeInTheDocument();
    expect(screen.getByText(/Trains in both directions are combined/)).toBeInTheDocument();
    // A line's stations come with the site, and are always shown.
    expect(drawn('stops').length).toBeGreaterThan(10);
    expect(screen.getByTestId('stop-zoom')).toHaveTextContent('0');
    // No shapes file is fetched for a rail line.
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/shapes/'))).toBe(true);
    expect(screen.getByText(/how fast trains moved/)).toBeInTheDocument();
    // The rail bands call 15 mph slow: one of three stretches shown.
    expect(screen.getByText(/1 of 3 stretches under 15 mph/)).toBeInTheDocument();
  });
});

describe('RouteMap', () => {
  it('draws the route when its shape is published', async () => {
    serve({ 'shapes/17.json': { schema_version: 1, route: '17', directions: { 0: LINE } } });
    render(<RouteMap route="17" label="Route 17" />);
    expect(await screen.findByTestId('map')).toHaveAttribute('data-label', 'Map of Route 17');
    // A line for each direction's shape, and a dot at each end.
    expect(drawn('lines')).toHaveLength(1);
    expect(drawn('dots')).toHaveLength(2);
    expect(drawn('stops')).toEqual([]);
  });

  it('gives the map the route’s stops, both directions’, once each', async () => {
    serve({
      'shapes/17.json': {
        schema_version: 1,
        route: '17',
        directions: { 0: LINE },
        stops: {
          0: [[40.0, -75.17, 'Front St & Market St']],
          1: [
            [40.0, -75.17, 'Front St & Market St'],
            [40.02, -75.17, '20th St & Johnston St'],
          ],
        },
      },
    });
    render(<RouteMap route="17" label="Route 17" />);
    await screen.findByTestId('stops');
    expect(drawn('stops')).toEqual(['Front St & Market St', '20th St & Johnston St']);
  });

  it('draws nothing without a shape', async () => {
    serve({});
    const { container } = render(<RouteMap route="17" label="Route 17" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
