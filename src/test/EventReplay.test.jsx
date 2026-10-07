import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventReplay from '../components/EventReplay.jsx';
import { fetchEventTrack } from '../lib/eventTracks.js';

vi.mock('../lib/eventTracks.js', () => ({ fetchEventTrack: vi.fn() }));

// Two trains, one each way, along the L1 between 34th St and 15th St/City Hall.
const T0 = Date.UTC(2026, 9, 7, 14, 0, 0);
const TRACK = {
  t0: T0,
  durSec: 600,
  onset: T0 + 120_000,
  resolved: T0 + 480_000,
  affectedDir: 1,
  vehicles: [
    {
      id: '4001',
      dir: 0,
      s: [
        [0, 39.9553, -75.1912],
        [300, 39.9526, -75.1836],
        [600, 39.9526, -75.1736],
      ],
    },
    {
      id: '4002',
      dir: 1,
      s: [
        [0, 39.9526, -75.1736],
        [300, 39.9526, -75.1836],
        [600, 39.9553, -75.1912],
      ],
    },
  ],
};

const props = {
  eventId: 'demo',
  lineKey: 'l1',
  fromStation: '34th St',
  toStation: '15th St/City Hall',
  directionLabel: 'toward 69th St Transit Center',
};

// jsdom has no matchMedia; `phone` says whether the narrow-screen query matches.
function stubMedia(phone) {
  window.matchMedia = (query) => ({
    matches: phone && query.includes('max-width'),
    addEventListener() {},
    removeEventListener() {},
  });
}

const viewBox = (svg) => svg.getAttribute('viewBox').split(' ').map(Number);

describe('EventReplay on a basemap', () => {
  beforeEach(() => {
    fetchEventTrack.mockResolvedValue(TRACK);
  });
  afterEach(() => {
    delete window.matchMedia;
    vi.clearAllMocks();
  });

  it('lays map tiles under the animated line and credits them', async () => {
    stubMedia(false);
    const { container } = render(<EventReplay {...props} />);
    await screen.findByText(/Watch it unfold/i);
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
    // The tiles are decoration; the animation keeps its accessible name.
    expect(
      screen.getByRole('img', { name: /Replay of trains on the L1 Line/ }),
    ).toBeInTheDocument();
    expect(container.querySelector('img').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('draws the trains at the playhead', async () => {
    stubMedia(false);
    render(<EventReplay {...props} />);
    await screen.findByText(/Watch it unfold/i);
    expect(screen.getByText(/2 trains on the line/)).toBeInTheDocument();
  });

  it('never turns the map: a phone gets a narrower canvas instead of a rotated one', async () => {
    stubMedia(true);
    render(<EventReplay {...props} />);
    const svg = await screen.findByRole('img', { name: /Replay of trains on the L1 Line/ });
    const [, , w, h] = viewBox(svg);
    expect(w).toBe(400);
    expect(h).toBeLessThanOrEqual(520);
    // West stays left: 34th St is west of 15th St/City Hall.
    const dots = [...svg.querySelectorAll('circle')].filter((c) => c.querySelector('title'));
    const x = (name) =>
      Number(dots.find((c) => c.querySelector('title').textContent === name).getAttribute('cx'));
    expect(x('34th St')).toBeLessThan(x('15th St/City Hall'));
  });

  it('keeps the direction arrow on the canvas, even for a line that hugs an edge', async () => {
    for (const phone of [false, true]) {
      stubMedia(phone);
      const { unmount } = render(<EventReplay {...props} />);
      const svg = await screen.findByRole('img', { name: /Replay of trains on the L1 Line/ });
      const [, , w, h] = viewBox(svg);
      // The arrow (and its halo) is the pair of stroked paths in the round-capped group.
      const arrow = svg.querySelectorAll('g[stroke-linecap="round"] path');
      expect(arrow.length).toBeGreaterThan(0);
      for (const path of arrow) {
        const nums = path
          .getAttribute('d')
          .match(/-?\d+(\.\d+)?/g)
          .map(Number);
        for (let i = 0; i < nums.length; i += 2) {
          expect(nums[i]).toBeGreaterThanOrEqual(0);
          expect(nums[i]).toBeLessThanOrEqual(w);
          expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
          expect(nums[i + 1]).toBeLessThanOrEqual(h);
        }
      }
      unmount();
    }
  });

  it('renders nothing without a track', async () => {
    stubMedia(false);
    fetchEventTrack.mockResolvedValue(null);
    const { container } = render(<EventReplay {...props} />);
    await waitFor(() => expect(fetchEventTrack).toHaveBeenCalled());
    expect(container.querySelector('svg')).toBeNull();
  });
});
