import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByRole('img', { name: /averaging 9\.1 mph/ })).toBeInTheDocument();
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
    expect(screen.getByRole('img', { name: /Route 17 southbound/ })).toBeInTheDocument();
  });

  it('draws nothing for a route without speeds', async () => {
    serve({});
    const { container } = render(<SpeedMap route="17" label="Route 17" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
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
    expect(screen.getByRole('img', { name: /how fast trains moved/ })).toBeInTheDocument();
    // The rail bands call 15 mph slow: one of three stretches shown.
    expect(screen.getByRole('img', { name: /1 of 3 stretches under 15 mph/ })).toBeInTheDocument();
  });
});

describe('RouteMap', () => {
  it('draws the route when its shape is published', async () => {
    serve({ 'shapes/17.json': { schema_version: 1, route: '17', directions: { 0: LINE } } });
    render(<RouteMap route="17" label="Route 17" />);
    expect(await screen.findByRole('img', { name: 'Map of Route 17' })).toBeInTheDocument();
  });

  it('draws nothing without a shape', async () => {
    serve({});
    const { container } = render(<RouteMap route="17" label="Route 17" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
