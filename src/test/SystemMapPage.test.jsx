import '@testing-library/jest-dom';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Leaflet is covered in InteractiveMap.test.jsx; here the map is a stand-in that
// shows what it was asked to draw and lets a test click a line.
vi.mock('../components/InteractiveMap.jsx', () => ({
  default: ({ label, lines, stops, stopZoom, stopsLabel, gestures, canvas, onLineClick, fit }) => (
    <div
      data-testid="map"
      data-label={label}
      data-gestures={gestures}
      data-canvas={String(Boolean(canvas))}
      data-stop-zoom={stopZoom}
      data-stops-label={stopsLabel}
      data-fit={JSON.stringify(fit)}
    >
      <span data-testid="route-ids">
        {JSON.stringify([...new Set(lines.map((l) => l.routeId))])}
      </span>
      <span data-testid="line-colors">{JSON.stringify(lines.map((l) => l.color))}</span>
      <span data-testid="stops">{JSON.stringify(stops.map((s) => s.mode))}</span>
      {lines.map((l) => (
        <button
          key={l.id}
          type="button"
          data-testid={`pick-${l.id}`}
          onClick={() => onLineClick(l.id)}
        >
          {l.id}
        </button>
      ))}
    </div>
  ),
}));

import SystemMapPage from '../components/SystemMapPage.jsx';
import { METRO_LAYER, RAIL_LAYER } from '../lib/systemMap.js';

const LINE = [
  [39.95, -75.17],
  [39.96, -75.17],
];
const SYSTEM_MAP = {
  schema_version: 1,
  generated_at: 1,
  routes: { 17: [LINE, LINE], K: [LINE], 'L1-OWL': [LINE] },
};

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
const systemMapFetches = () =>
  fetch.mock.calls.filter(([url]) => String(url).endsWith('/system-map.json')).length;

const routeIds = () => JSON.parse(screen.getByTestId('route-ids').textContent);
const modesDrawn = () => [...new Set(routeIds().map((id) => id.split(':')[0]))];
const stopModes = () => [...new Set(JSON.parse(screen.getByTestId('stops').textContent))];
const chip = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const openAt = async (search = '') => {
  window.history.replaceState(null, '', `/map${search}`);
  render(<SystemMapPage />);
  await screen.findByTestId('map');
};

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
  serve({ 'system-map.json': SYSTEM_MAP });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('SystemMapPage', () => {
  it('draws every mode, and asks the map to behave as the page', async () => {
    await openAt();
    await waitFor(() => expect(modesDrawn()).toEqual(['bus', 'rail', 'metro']));
    const map = screen.getByTestId('map');
    expect(map).toHaveAttribute('data-gestures', 'free');
    expect(map).toHaveAttribute('data-canvas', 'true');
    expect(map).toHaveAttribute('data-stops-label', 'stations');
    expect(Number(map.dataset.stopZoom)).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1, name: 'System map' })).toBeInTheDocument();
    expect(document.title).toMatch(/^System map · /);
  });

  it('draws Metro and Regional Rail at once, and the buses when their file arrives', async () => {
    let release;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    await openAt();
    expect(modesDrawn()).toEqual(['rail', 'metro']);
    expect(screen.getByText('Loading bus routes…')).toBeInTheDocument();
    release({ ok: true, json: async () => SYSTEM_MAP });
    await waitFor(() => expect(modesDrawn()).toEqual(['bus', 'rail', 'metro']));
    expect(screen.queryByText('Loading bus routes…')).not.toBeInTheDocument();
    // Four lines on three routes.
    expect(routeIds().filter((id) => id.startsWith('bus:'))).toEqual([
      'bus:17',
      'bus:K',
      'bus:L1-OWL',
    ]);
  });

  it('says so, and still draws the rest, when the bus routes aren’t published', async () => {
    serve({});
    await openAt();
    expect(await screen.findByText(/Bus route lines aren’t available/)).toBeInTheDocument();
    expect(modesDrawn()).toEqual(['rail', 'metro']);
  });

  it('counts each mode’s lines, the buses once they’re known', async () => {
    await openAt();
    expect(chip('SEPTA Metro')).toHaveTextContent(`${METRO_LAYER.routes.size} lines`);
    expect(chip('Regional Rail')).toHaveTextContent(`${RAIL_LAYER.routes.size} lines`);
    await waitFor(() => expect(chip('Bus')).toHaveTextContent('3 routes'));
  });

  describe('the mode filter', () => {
    it('starts on All, with no mode picked out', async () => {
      await openAt();
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
      for (const name of ['SEPTA Metro', 'Bus', 'Regional Rail']) {
        expect(chip(name)).toHaveAttribute('aria-pressed', 'false');
      }
      expect(screen.getByRole('group', { name: 'Modes to show' })).toBeInTheDocument();
    });

    it('narrows to a mode, adds a second, and drops one', async () => {
      await openAt();
      await waitFor(() => expect(modesDrawn()).toHaveLength(3));

      await userEvent.click(chip('Regional Rail'));
      expect(modesDrawn()).toEqual(['rail']);
      expect(chip('Regional Rail')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

      await userEvent.click(chip('SEPTA Metro'));
      expect(modesDrawn()).toEqual(['rail', 'metro']);
      expect(chip('SEPTA Metro')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Regional Rail')).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(chip('Regional Rail'));
      expect(modesDrawn()).toEqual(['metro']);
    });

    it('can show buses with either of the others', async () => {
      await openAt();
      await userEvent.click(chip('Bus'));
      await userEvent.click(chip('Regional Rail'));
      await waitFor(() => expect(modesDrawn()).toEqual(['bus', 'rail']));
    });

    it('goes back to All when the last mode is cleared, and from anywhere with All', async () => {
      await openAt();
      await userEvent.click(chip('Bus'));
      await waitFor(() => expect(modesDrawn()).toEqual(['bus']));
      await userEvent.click(chip('Bus'));
      expect(modesDrawn()).toEqual(['bus', 'rail', 'metro']);
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(chip('SEPTA Metro'));
      await userEvent.click(chip('Regional Rail'));
      expect(modesDrawn()).toEqual(['rail', 'metro']);
      await userEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(modesDrawn()).toEqual(['bus', 'rail', 'metro']);
    });

    it('shows a mode’s stations with it, and the buses have none', async () => {
      await openAt();
      expect(stopModes().sort()).toEqual(['metro', 'rail']);
      await userEvent.click(chip('Bus'));
      expect(stopModes()).toEqual([]);
      await userEvent.click(chip('SEPTA Metro'));
      expect(stopModes()).toEqual(['metro']);
    });

    it('keys only the modes on show', async () => {
      await openAt();
      const key = () => within(screen.getByRole('list', { name: 'Map key' }));
      expect(key().getByText('Bus routes')).toBeInTheDocument();
      expect(key().getByText('Regional Rail')).toBeInTheDocument();
      expect(key().getByText('Market-Frankford')).toBeInTheDocument();
      await userEvent.click(chip('Regional Rail'));
      expect(key().queryByText('Bus routes')).not.toBeInTheDocument();
      expect(key().queryByText('Market-Frankford')).not.toBeInTheDocument();
      expect(key().getByText('Regional Rail')).toBeInTheDocument();
    });
  });

  describe('in the URL', () => {
    it('starts on the modes in the link', async () => {
      await openAt('?modes=metro,rail');
      expect(modesDrawn()).toEqual(['rail', 'metro']);
      expect(chip('SEPTA Metro')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Bus')).toHaveAttribute('aria-pressed', 'false');
    });

    it('does not fetch the bus routes for a link without them, until they’re wanted', async () => {
      await openAt('?modes=metro');
      expect(systemMapFetches()).toBe(0);
      await userEvent.click(chip('Bus'));
      await waitFor(() => expect(modesDrawn()).toEqual(['bus', 'metro']));
      expect(systemMapFetches()).toBe(1);
      // Switching away and back doesn't ask again.
      await userEvent.click(chip('Bus'));
      await userEvent.click(chip('Bus'));
      expect(systemMapFetches()).toBe(1);
    });

    it('fetches the bus routes once', async () => {
      await openAt();
      await waitFor(() => expect(modesDrawn()).toContain('bus'));
      expect(systemMapFetches()).toBe(1);
    });

    it('keeps the modes picked in the address, and nothing for All', async () => {
      await openAt();
      expect(window.location.search).toBe('');
      await userEvent.click(chip('Regional Rail'));
      await userEvent.click(chip('SEPTA Metro'));
      expect(window.location.pathname).toBe('/map');
      expect(window.location.search).toBe('?modes=metro,rail');
      await userEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(window.location.search).toBe('');
    });

    it('leaves other params alone', async () => {
      await openAt('?utm=x');
      await userEvent.click(chip('Bus'));
      expect(new URLSearchParams(window.location.search).get('utm')).toBe('x');
      expect(new URLSearchParams(window.location.search).get('modes')).toBe('bus');
    });

    it('shows every mode for a link whose modes it doesn’t know', async () => {
      await openAt('?modes=ferry');
      await waitFor(() => expect(modesDrawn()).toEqual(['bus', 'rail', 'metro']));
    });
  });

  describe('selecting a route', () => {
    it('names it, links to its page, and outlines it on the map', async () => {
      await openAt();
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      expect(screen.getByText('Market-Frankford Line')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /View alerts & history/ })).toHaveAttribute(
        'href',
        '/line/l1',
      );
      // Drawn again on top in white.
      const colors = JSON.parse(screen.getByTestId('line-colors').textContent);
      expect(colors.at(-1)).toBe('#ffffff');
    });

    it('works for a bus route and a Regional Rail line', async () => {
      await openAt();
      await waitFor(() => expect(screen.getByTestId('pick-bus:17:0')).toBeInTheDocument());
      await userEvent.click(screen.getByTestId('pick-bus:17:0'));
      expect(screen.getByRole('link', { name: /View alerts & history/ })).toHaveAttribute(
        'href',
        '/route/17',
      );
      expect(screen.getByText('Front-Mkt to 20-Johnston')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('pick-rail:pao:0'));
      expect(screen.getByRole('link', { name: /View alerts & history/ })).toHaveAttribute(
        'href',
        '/rail/line/pao',
      );
      expect(screen.getByText('Paoli/Thorndale Line')).toBeInTheDocument();
    });

    it('lets go of it when it is picked again, or cleared', async () => {
      await openAt();
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      expect(screen.queryByRole('link', { name: /View alerts & history/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      await userEvent.click(screen.getByRole('button', { name: 'Clear selected route' }));
      expect(screen.queryByRole('link', { name: /View alerts & history/ })).not.toBeInTheDocument();
    });

    it('keeps it while other modes come and go', async () => {
      await openAt();
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      await userEvent.click(chip('SEPTA Metro'));
      await userEvent.click(chip('Regional Rail'));
      expect(screen.getByRole('link', { name: /View alerts & history/ })).toHaveAttribute(
        'href',
        '/line/l1',
      );
    });

    it('drops it when its mode is switched off', async () => {
      await openAt();
      await userEvent.click(screen.getByTestId('pick-metro:l1:0'));
      expect(screen.getByRole('link', { name: /View alerts & history/ })).toBeInTheDocument();
      await userEvent.click(chip('Regional Rail'));
      expect(screen.queryByRole('link', { name: /View alerts & history/ })).not.toBeInTheDocument();
      // And it isn't quietly selected again when Metro comes back.
      await userEvent.click(chip('SEPTA Metro'));
      expect(screen.queryByRole('link', { name: /View alerts & history/ })).not.toBeInTheDocument();
    });
  });
});
