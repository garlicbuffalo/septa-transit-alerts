import '@testing-library/jest-dom';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Leaflet is covered in InteractiveMap.test.jsx; here the map is a stand-in that shows what
// it was asked to draw and keeps what it was given, so a test can report where the pointer
// is the way the real map does.
const mapProps = vi.hoisted(() => ({}));
vi.mock('../components/InteractiveMap.jsx', () => ({
  default: (props) => {
    Object.assign(mapProps, props);
    const {
      label,
      lines,
      highlight,
      dots,
      stops,
      stopZoom,
      stopsLabel,
      gestures,
      canvas,
      fit,
      children,
    } = props;
    return (
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
        <span data-testid="highlight-colors">{JSON.stringify(highlight.map((l) => l.color))}</span>
        <span data-testid="dots">{JSON.stringify(dots.map((d) => d.point))}</span>
        <span data-testid="stops">{JSON.stringify(stops.map((s) => s.mode))}</span>
        {children}
      </div>
    );
  },
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

  describe('what is at a point', () => {
    // Bus routes on a street far from any Metro or Regional Rail line, where the
    // pointer can be put exactly: a degree of longitude here is about 84 km.
    const street = (lon) => [
      [41, lon],
      [41.01, lon],
    ];
    const FAR = [41.2, -80];
    // A pointer 10 px from a route is 100 m away at 10 m a pixel.
    const pointer = (lat, lon, over = {}) => ({
      lat,
      lon,
      x: 100,
      y: 100,
      width: 800,
      height: 600,
      top: 0,
      bottom: 600,
      metersPerPx: 10,
      touch: false,
      ...over,
    });
    const send = (type, lat, lon, over) =>
      act(() => mapProps.onPointer({ type, ...pointer(lat, lon, over) }));
    const hover = (...args) => send('hover', ...args);
    const pick = (...args) => send('pick', ...args);
    const tip = () => screen.queryByText(/click to list them all/)?.parentElement ?? null;
    const popup = () => screen.queryByRole('region', { name: 'Routes at this spot' });
    const hrefs = () =>
      within(popup())
        .getAllByRole('link')
        .map((a) => a.getAttribute('href'));
    const NEAR = 41.005;
    const mapOf = (routes) => ({ schema_version: 1, generated_at: 1, routes });

    const withRoutes = async (routes, search = '') => {
      serve({ 'system-map.json': mapOf(routes) });
      await openAt(search);
      await waitFor(() => expect(modesDrawn()).toContain('bus'));
    };

    it('lists the routes under the mouse, beside it, with what SEPTA calls each', async () => {
      await withRoutes({ 17: [street(-80)], K: [street(-80)], 33: [street(-80.01)] });
      hover(NEAR, -80);
      expect(screen.getByText('Front-Mkt to 20-Johnston')).toBeInTheDocument();
      expect(screen.getByText('17')).toBeInTheDocument();
      expect(screen.getByText('K')).toBeInTheDocument();
      // Route 33 is a street away.
      expect(screen.queryByText('33')).not.toBeInTheDocument();
    });

    it('lists them in the site’s order, not the order of their lines', async () => {
      await withRoutes({ K: [street(-80)], 21: [street(-80)], 2: [street(-80)] });
      hover(NEAR, -80);
      const labels = within(screen.getByTestId('map'))
        .getAllByText(/^(2|21|K)$/)
        .map((el) => el.textContent);
      expect(labels).toEqual(['2', '21', 'K']);
    });

    it('lists every mode there, Metro first, not only the top one', async () => {
      const [lat, lon] = METRO_LAYER.lines.find((l) => l.routeId === 'metro:l1').points[3];
      await withRoutes({
        17: [
          [
            [lat - 0.001, lon],
            [lat + 0.001, lon],
          ],
        ],
        K: [
          [
            [lat, lon - 0.001],
            [lat, lon + 0.001],
          ],
        ],
      });
      hover(lat, lon);
      const rows = within(screen.getByTestId('map'));
      expect(rows.getByText('L1')).toBeInTheDocument();
      expect(rows.getByText('Market-Frankford Line')).toBeInTheDocument();
      expect(rows.getByText('17')).toBeInTheDocument();
      expect(rows.getByText('K')).toBeInTheDocument();
      const labels = rows.getAllByText(/^(L1|17|K)$/).map((el) => el.textContent);
      expect(labels).toEqual(['L1', '17', 'K']);
    });

    it('finds a thin bus line a few pixels off it, but not one further than that', async () => {
      await withRoutes({ 17: [street(-80)] });
      // 0.0009° of longitude is about 76 m, which is under 8 px at 10 m a pixel.
      hover(NEAR, -80 + 0.0009);
      expect(screen.getByText('17')).toBeInTheDocument();
      hover(NEAR, -80 + 0.002);
      expect(screen.queryByText('17')).not.toBeInTheDocument();
    });

    it('shows nothing where there is nothing, and when the mouse leaves', async () => {
      await withRoutes({ 17: [street(-80)] });
      hover(...FAR);
      expect(screen.queryByText('17')).not.toBeInTheDocument();
      hover(NEAR, -80);
      expect(screen.getByText('17')).toBeInTheDocument();
      act(() => mapProps.onPointer({ type: 'leave' }));
      expect(screen.queryByText('17')).not.toBeInTheDocument();
    });

    it('shows the first few and counts the rest', async () => {
      const routes = Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), [street(-80)]]),
      );
      await withRoutes(routes);
      hover(NEAR, -80);
      expect(within(screen.getByTestId('map')).getAllByText(/^\d$/)).toHaveLength(6);
      expect(screen.getByText('+3 more · click to list them all')).toBeInTheDocument();
    });

    it('does not follow a finger: a tap is a pick, not a hover', async () => {
      await withRoutes({ 17: [street(-80)] });
      hover(NEAR, -80, { touch: true });
      expect(tip()).toBeNull();
      expect(screen.queryByText('17')).not.toBeInTheDocument();
    });

    it('keeps the card on the screen: beside the mouse, flipped where there is no room', async () => {
      await withRoutes({ 17: [street(-80)] });
      hover(NEAR, -80, { x: 100, y: 100 });
      const card = screen.getByText('Front-Mkt to 20-Johnston').closest('div[style*="left"]');
      expect(card).toHaveStyle({ left: '114px', top: '114px', width: '256px' });
      // Near the right edge it goes to the left of the mouse.
      hover(NEAR, -80, { x: 700, y: 300 });
      const left = screen.getByText('Front-Mkt to 20-Johnston').closest('div[style*="left"]');
      expect(left.style.left).toBe('430px');
      expect(left.style.top).toBe('314px');
      // Near the bottom edge it goes over it.
      hover(NEAR, -80, { x: 100, y: 580 });
      const above = screen.getByText('Front-Mkt to 20-Johnston').closest('div[style*="left"]');
      expect(above.style.top).toBe('532px');
    });

    describe('a click or tap', () => {
      it('lists every route there with a link to its page, and says how many', async () => {
        await withRoutes({ 17: [street(-80)], K: [street(-80)], 33: [street(-80.01)] });
        pick(NEAR, -80);
        expect(popup()).toBeInTheDocument();
        expect(screen.getByText('2 routes here')).toBeInTheDocument();
        const links = within(popup()).getAllByRole('link');
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/route/17', '/route/K']);
        expect(links[0]).toHaveTextContent('Front-Mkt to 20-Johnston');
      });

      it('lists more than six routes in a list that scrolls, its last row cut short', async () => {
        const nine = Object.fromEntries(
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), [street(-80)]]),
        );
        await withRoutes(nine);
        pick(NEAR, -80);
        expect(screen.getByText('9 routes here')).toBeInTheDocument();
        const list = within(popup()).getByRole('list');
        // Every route is in the list, and its height is five and a half rows (and a margin).
        expect(within(list).getAllByRole('link')).toHaveLength(9);
        expect(list).toHaveStyle({ maxHeight: '224px' });
      });

      it('shows six routes in full, with nothing to scroll to', async () => {
        const six = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), [street(-80)]]));
        await withRoutes(six);
        pick(NEAR, -80);
        expect(screen.getByText('6 routes here')).toBeInTheDocument();
        expect(within(popup()).getByRole('list')).toHaveStyle({ maxHeight: '244px' });
      });

      it('says "1 route" for one', async () => {
        await withRoutes({ 17: [street(-80)] });
        pick(NEAR, -80);
        expect(screen.getByText('1 route here')).toBeInTheDocument();
      });

      it('links a Metro line and a Regional Rail line to theirs', async () => {
        const [lat, lon] = METRO_LAYER.lines.find((l) => l.routeId === 'metro:l1').points[3];
        await withRoutes({ 99: [street(-80)] });
        pick(lat, lon, { metersPerPx: 1 });
        expect(within(popup()).getByRole('link', { name: /L1/ })).toHaveAttribute(
          'href',
          '/line/l1',
        );
        const [rlat, rlon] = RAIL_LAYER.lines.find((l) => l.routeId === 'rail:pao').points[5];
        pick(rlat, rlon, { metersPerPx: 1 });
        expect(within(popup()).getByRole('link', { name: /PAO/ })).toHaveAttribute(
          'href',
          '/rail/line/pao',
        );
      });

      it('outlines those routes on the map, and marks the spot', async () => {
        await withRoutes({ 17: [street(-80)], 33: [street(-80.01)] });
        const linesBefore = mapProps.lines;
        expect(JSON.parse(screen.getByTestId('highlight-colors').textContent)).toEqual([]);
        expect(JSON.parse(screen.getByTestId('dots').textContent)).toEqual([]);
        pick(NEAR, -80);
        const colors = JSON.parse(screen.getByTestId('highlight-colors').textContent);
        expect(colors.filter((c) => c === '#ffffff')).toHaveLength(1);
        // The outline is its own layer: the lines under it are the same ones, not redrawn.
        expect(mapProps.lines).toBe(linesBefore);
        expect(screen.getByTestId('line-colors').textContent).not.toContain('#ffffff');
        expect(JSON.parse(screen.getByTestId('dots').textContent)).toEqual([[NEAR, -80]]);
      });

      it('takes the hover card away', async () => {
        await withRoutes({ 17: [street(-80)] });
        hover(NEAR, -80);
        expect(tip()).toBeNull();
        expect(screen.getByText('17')).toBeInTheDocument();
        pick(NEAR, -80);
        expect(within(screen.getByTestId('map')).queryByText(/click to list/)).toBeNull();
        expect(within(popup()).getByText('17')).toBeInTheDocument();
      });

      it('reaches further for a fingertip than for a mouse', async () => {
        await withRoutes({ 17: [street(-80)] });
        // 0.0013° of longitude is about 109 m: 10.9 px at 10 m a pixel.
        pick(NEAR, -80 + 0.0013);
        expect(popup()).toBeNull();
        pick(NEAR, -80 + 0.0013, { touch: true });
        expect(popup()).toBeInTheDocument();
      });

      it('goes when the map is picked where there is nothing', async () => {
        await withRoutes({ 17: [street(-80)] });
        pick(NEAR, -80);
        expect(popup()).toBeInTheDocument();
        pick(...FAR);
        expect(popup()).toBeNull();
        expect(JSON.parse(screen.getByTestId('dots').textContent)).toEqual([]);
        expect(JSON.parse(screen.getByTestId('highlight-colors').textContent)).toEqual([]);
      });

      it('goes when the map moves or zooms, since the spot would no longer be where it was', async () => {
        await withRoutes({ 17: [street(-80)] });
        pick(NEAR, -80);
        act(() => mapProps.onPointer({ type: 'move' }));
        expect(popup()).toBeNull();
        expect(JSON.parse(screen.getByTestId('dots').textContent)).toEqual([]);
      });

      it('goes when it is closed', async () => {
        await withRoutes({ 17: [street(-80)] });
        pick(NEAR, -80);
        await userEvent.click(screen.getByRole('button', { name: 'Close route list' }));
        expect(popup()).toBeNull();
      });

      it('stays through a mouse leaving the map, to get at its links', async () => {
        await withRoutes({ 17: [street(-80)] });
        pick(NEAR, -80);
        act(() => mapProps.onPointer({ type: 'leave' }));
        expect(popup()).toBeInTheDocument();
      });

      it('is let go of when the modes change, and lists only the modes on show', async () => {
        const [lat, lon] = METRO_LAYER.lines.find((l) => l.routeId === 'metro:l1').points[3];
        await withRoutes({
          17: [
            [
              [lat - 0.001, lon],
              [lat + 0.001, lon],
            ],
          ],
        });
        pick(lat, lon, { metersPerPx: 1 });
        expect(hrefs()).toEqual(['/line/l1', '/route/17']);
        // From All, a mode narrows the map to it (as on the Stations page).
        await userEvent.click(chip('Bus'));
        expect(popup()).toBeNull();
        pick(lat, lon, { metersPerPx: 1 });
        expect(hrefs()).toEqual(['/route/17']);
        await userEvent.click(chip('SEPTA Metro'));
        expect(popup()).toBeNull();
        pick(lat, lon, { metersPerPx: 1 });
        expect(hrefs()).toEqual(['/line/l1', '/route/17']);
      });

      it('keeps the list out of the part of the map that is out of sight', async () => {
        await withRoutes({ 17: [street(-80)], K: [street(-80)], 33: [street(-80)] });
        // The map runs 300 px off the bottom of this 768 px window (under a tab bar, say),
        // so only its top 294 px (less the margin) are in sight. A point at 250 px is in sight,
        // but a list of three rows (36 + 3 × 40 + 8 = 164 px) would run past the edge under
        // it, so it goes over the point instead.
        pick(NEAR, -80, { x: 100, y: 250, bottom: window.innerHeight + 300 });
        expect(popup()).toHaveStyle({ top: '70px', left: '116px' });
        // With the whole map in sight, the same point has room underneath.
        pick(NEAR, -80, { x: 100, y: 250, bottom: 600 });
        expect(popup()).toHaveStyle({ top: '266px' });
      });
    });
  });
});
