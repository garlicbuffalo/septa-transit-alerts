import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// jsdom has no SVG geometry or layout, which Leaflet checks for when it loads
// and when it sizes the map.
vi.hoisted(() => {
  window.SVGSVGElement.prototype.createSVGRect = () => ({});
});
const size = { w: 600, h: 400 };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => size.w });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => size.h });
});

const { default: InteractiveMap } = await import('../components/InteractiveMap.jsx');
const { resetSource } = await import('../lib/basemap.js');

const ROUTE = [
  [39.95, -75.19],
  [39.96, -75.17],
  [39.98, -75.14],
];
const props = {
  label: 'Route 17',
  fit: ROUTE,
  lines: [
    { id: 'a', points: ROUTE, color: '#60a5fa' },
    { id: 'b', points: ROUTE.slice(0, 2), color: '#ff2a2a', tip: '3.2 mph (30 readings)' },
  ],
  dots: [{ id: 'start', point: ROUTE[0] }],
};

const zoomOf = (container) => {
  const src = container.querySelector('img.leaflet-tile')?.getAttribute('src') ?? '';
  return Number(/\/(\d+)\/\d+\/\d+/.exec(src)?.[1]);
};
const tiles = (container) => [...container.querySelectorAll('img.leaflet-tile')];

afterEach(() => {
  act(() => resetSource());
  vi.useRealTimers();
});

const STOPS = [
  { id: '0:0', point: ROUTE[0], name: 'Front St & Market St' },
  { id: '0:1', point: ROUTE[1], name: '20th St & Johnston St' },
];
// Dots in the stops' own pane: a visible dot and a larger hit circle for each stop.
const stopPaths = (container) => container.querySelectorAll('.leaflet-stops-pane path');
const zoomIn = async (times) => {
  for (let i = 0; i < times; i++) await userEvent.click(screen.getByTitle('Zoom in'));
};

describe('InteractiveMap', () => {
  it('draws each line over its dark edge, and a dot for each end', () => {
    const { container } = render(<InteractiveMap {...props} />);
    const paths = container.querySelectorAll('.leaflet-overlay-pane path');
    // Two lines drawn twice (edge and color), and one dot.
    expect(paths).toHaveLength(5);
    // Only a line with something to say can be hovered.
    expect(container.querySelectorAll('path.leaflet-interactive')).toHaveLength(1);
    expect(screen.getByRole('region', { name: /Route 17\. Interactive map/ })).toBeInTheDocument();
  });

  it('asks the page’s tile source for tiles that cover the route', () => {
    const { container } = render(<InteractiveMap {...props} />);
    expect(tiles(container).length).toBeGreaterThan(0);
    expect(tiles(container)[0].getAttribute('src')).toMatch(
      /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/,
    );
    // OpenStreetMap's light tiles are darkened.
    expect(container.querySelector('.leaflet-tile-container').parentElement.style.filter).toMatch(
      /invert/,
    );
  });

  it('zooms with the buttons, and Reset view goes back to the route', async () => {
    const { container } = render(<InteractiveMap {...props} />);
    const start = zoomOf(container);
    await userEvent.click(screen.getByTitle('Zoom in'));
    await userEvent.click(screen.getByTitle('Zoom in'));
    expect(zoomOf(container)).toBeGreaterThan(start);
    await userEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(zoomOf(container)).toBe(start);
  });

  it('leaves the wheel to the page, with a hint, and zooms on Ctrl + wheel', () => {
    vi.useFakeTimers();
    const { container } = render(<InteractiveMap {...props} />);
    const map = screen.getByRole('region', { name: /Interactive map/ });
    const start = zoomOf(container);

    const plain = new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true });
    act(() => {
      map.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(zoomOf(container)).toBe(start);
    expect(screen.getByText(/scroll to zoom the map/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/scroll to zoom the map/)).not.toBeInTheDocument();

    const ctrl = new WheelEvent('wheel', {
      deltaY: -400,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      map.dispatchEvent(ctrl);
    });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(zoomOf(container)).toBeGreaterThan(start);
  });

  it('redraws new lines without moving the view', async () => {
    const { container, rerender } = render(<InteractiveMap {...props} />);
    await userEvent.click(screen.getByTitle('Zoom in'));
    await userEvent.click(screen.getByTitle('Zoom in'));
    const zoomed = zoomOf(container);
    rerender(
      <InteractiveMap
        {...props}
        lines={[{ id: 'c', points: ROUTE, color: '#2ad17f' }]}
        dots={[]}
      />,
    );
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(2);
    expect(zoomOf(container)).toBe(zoomed);
  });

  it('refits when the points to fit change, as when the other direction is chosen', async () => {
    const { container, rerender } = render(<InteractiveMap {...props} />);
    const start = zoomOf(container);
    await userEvent.click(screen.getByTitle('Zoom in'));
    await userEvent.click(screen.getByTitle('Zoom in'));
    expect(zoomOf(container)).toBeGreaterThan(start);
    // A different, much shorter route: fitted at a different zoom than before.
    const short = [
      [39.95, -75.19],
      [39.951, -75.189],
    ];
    rerender(
      <InteractiveMap {...props} fit={short} lines={[{ id: 'c', points: short, color: '#fff' }]} />,
    );
    expect(zoomOf(container)).not.toBe(start);
    expect(zoomOf(container)).toBeGreaterThan(start);
  });

  it('keeps the reader’s view when it re-renders for its own reasons', async () => {
    // Showing and hiding the scroll hint re-renders the map; with no dots passed,
    // that must not look like new dots and reset a view the reader has zoomed.
    vi.useFakeTimers();
    const { container } = render(<InteractiveMap {...props} dots={undefined} />);
    act(() => {
      screen.getByTitle('Zoom in').click();
      screen.getByTitle('Zoom in').click();
    });
    const zoomed = zoomOf(container);
    const map = screen.getByRole('region', { name: /Interactive map/ });
    act(() => {
      map.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    });
    expect(screen.getByText(/scroll to zoom the map/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/scroll to zoom the map/)).not.toBeInTheDocument();
    expect(zoomOf(container)).toBe(zoomed);
  });

  it('moves to the fallback tiles when the primary can’t serve any', () => {
    act(() => resetSource('https://relay.example/api/tiles'));
    const { container } = render(<InteractiveMap {...props} />);
    expect(tiles(container)[0].getAttribute('src')).toMatch(/^https:\/\/relay\.example\//);
    act(() => {
      for (const img of tiles(container).slice(0, 2)) fireEvent.error(img);
    });
    expect(tiles(container)[0].getAttribute('src')).toMatch(
      /^https:\/\/tile\.openstreetmap\.org\//,
    );
  });

  describe('stops', () => {
    it('shows none at the whole-route view, with a cue to zoom in, then shows them zoomed in', async () => {
      const { container } = render(<InteractiveMap {...props} stops={STOPS} stopZoom={16} />);
      expect(stopPaths(container)).toHaveLength(0);
      expect(screen.getByText('Zoom in to see stops')).toBeInTheDocument();
      await zoomIn(5);
      expect(zoomOf(container)).toBeGreaterThanOrEqual(16);
      expect(stopPaths(container)).toHaveLength(STOPS.length * 2);
      expect(screen.queryByText('Zoom in to see stops')).not.toBeInTheDocument();
    });

    it('takes them off again when zoomed back out', async () => {
      const { container } = render(<InteractiveMap {...props} stops={STOPS} stopZoom={16} />);
      await zoomIn(5);
      expect(stopPaths(container).length).toBeGreaterThan(0);
      await userEvent.click(screen.getByRole('button', { name: 'Reset view' }));
      expect(stopPaths(container)).toHaveLength(0);
      expect(screen.getByText('Zoom in to see stops')).toBeInTheDocument();
    });

    it('always shows them when the threshold is zero, with no cue', () => {
      const { container } = render(<InteractiveMap {...props} stops={STOPS} stopZoom={0} />);
      expect(stopPaths(container)).toHaveLength(STOPS.length * 2);
      expect(screen.queryByText('Zoom in to see stops')).not.toBeInTheDocument();
    });

    it('names a stop when it is hovered', async () => {
      const { container } = render(<InteractiveMap {...props} stops={STOPS} stopZoom={0} />);
      // The hit circles are the interactive ones in the stops pane.
      const hit = container.querySelectorAll('.leaflet-stops-pane path.leaflet-interactive');
      expect(hit).toHaveLength(STOPS.length);
      await userEvent.hover(hit[1]);
      expect(await screen.findByText('20th St & Johnston St')).toBeInTheDocument();
    });

    it('has no cue when there are no stops', () => {
      render(<InteractiveMap {...props} />);
      expect(screen.queryByText('Zoom in to see stops')).not.toBeInTheDocument();
    });

    it('swaps in new stops without moving the view', async () => {
      const { container, rerender } = render(
        <InteractiveMap {...props} stops={STOPS} stopZoom={0} />,
      );
      await zoomIn(2);
      const zoomed = zoomOf(container);
      rerender(<InteractiveMap {...props} stops={STOPS.slice(0, 1)} stopZoom={0} />);
      expect(stopPaths(container)).toHaveLength(2);
      expect(zoomOf(container)).toBe(zoomed);
    });
  });

  describe('as the page’s own map (gestures="free")', () => {
    it('zooms with the plain wheel, without a hint', () => {
      const { container } = render(<InteractiveMap {...props} gestures="free" />);
      const map = screen.getByRole('region', { name: /Interactive map/ });
      const start = zoomOf(container);
      const wheel = new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true });
      act(() => {
        map.dispatchEvent(wheel);
      });
      expect(wheel.defaultPrevented).toBe(true);
      expect(zoomOf(container)).toBeGreaterThan(start);
      expect(screen.queryByText(/scroll to zoom the map/)).not.toBeInTheDocument();
    });

    it('zooms out with the wheel the other way', () => {
      const { container } = render(<InteractiveMap {...props} gestures="free" />);
      const map = screen.getByRole('region', { name: /Interactive map/ });
      act(() => {
        map.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }),
        );
      });
      const zoomed = zoomOf(container);
      act(() => {
        map.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }),
        );
      });
      expect(zoomOf(container)).toBeLessThan(zoomed);
    });

    it('moves with one finger on a touchscreen, where the guarded map leaves it to the page', () => {
      const original = window.matchMedia;
      window.matchMedia = (query) => ({
        matches: query === '(pointer: coarse)',
        addEventListener() {},
        removeEventListener() {},
      });
      try {
        const guarded = render(<InteractiveMap {...props} />);
        expect(guarded.container.querySelector('.leaflet-touch-drag')).toBeNull();
        guarded.unmount();
        const free = render(<InteractiveMap {...props} gestures="free" />);
        expect(free.container.querySelector('.leaflet-touch-drag')).not.toBeNull();
        const map = screen.getByRole('region', { name: /Interactive map/ });
        act(() => {
          map.dispatchEvent(new Event('touchstart', { bubbles: true }));
        });
        expect(screen.queryByText(/two fingers/)).not.toBeInTheDocument();
      } finally {
        window.matchMedia = original;
      }
    });
  });

  describe('lines', () => {
    it('leaves out the dark edge of a line that asks to', () => {
      const { container } = render(
        <InteractiveMap
          {...props}
          dots={[]}
          lines={[
            { id: 'a', points: ROUTE, color: '#60a5fa' },
            { id: 'b', points: ROUTE, color: '#aab4c3', casing: false },
          ]}
        />,
      );
      // One edge and two colors.
      expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(3);
    });

    it('makes only a line with a tooltip hoverable', () => {
      const { container } = render(<InteractiveMap {...props} />);
      expect(container.querySelectorAll('path.leaflet-interactive')).toHaveLength(1);
    });

    it('shows a tooltip as text, not as HTML', async () => {
      const { container } = render(
        <InteractiveMap
          {...props}
          dots={[]}
          lines={[{ id: 'a', points: ROUTE, color: '#fff', tip: 'Route <b>17</b> & more' }]}
        />,
      );
      await userEvent.hover(container.querySelector('path.leaflet-interactive'));
      expect(await screen.findByText('Route <b>17</b> & more')).toBeInTheDocument();
      expect(container.querySelector('.leaflet-tooltip b')).toBeNull();
    });

    it('draws on a canvas, not an element per line, when asked', () => {
      const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
      try {
        const { container } = render(<InteractiveMap {...props} canvas />);
        expect(container.querySelector('.leaflet-overlay-pane canvas')).not.toBeNull();
        expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(0);
      } finally {
        getContext.mockRestore();
      }
    });
  });

  describe('onPointer', () => {
    const mapOf = (container) => container.querySelector('.leaflet-container');
    // Fitting the map to its route when it first shows is a move of the view, so it is
    // reported; these tests are about what comes after.
    const show = (extra = {}) => {
      const onPointer = vi.fn();
      const view = render(<InteractiveMap {...props} {...extra} onPointer={onPointer} />);
      expect(onPointer.mock.calls.map(([e]) => e.type)).toContain('move');
      onPointer.mockClear();
      return { onPointer, ...view };
    };
    // Leaflet works out where a mouse event is on the map from its coordinates.
    const at = (x, y, extra = {}) => ({ clientX: x, clientY: y, ...extra });

    it('reports a click or tap: where it is on the map, on screen, and how big a pixel is', () => {
      const { onPointer, container } = show();
      fireEvent.click(mapOf(container), at(20, 30));
      expect(onPointer).toHaveBeenCalledTimes(1);
      const [e] = onPointer.mock.calls[0];
      expect(e).toMatchObject({
        type: 'pick',
        x: 20,
        y: 30,
        width: 600,
        height: 400,
        touch: false,
      });
      expect(e.lat).toBeGreaterThan(39);
      expect(e.lat).toBeLessThan(41);
      expect(e.lon).toBeGreaterThan(-76);
      expect(e.lon).toBeLessThan(-74);
      expect(e.metersPerPx).toBeGreaterThan(0);
      expect(Number.isFinite(e.top)).toBe(true);
      expect(Number.isFinite(e.bottom)).toBe(true);
    });

    it('has a pixel that is half the size for each level the map is zoomed in', async () => {
      const { onPointer, container } = show();
      const size = () => {
        onPointer.mockClear();
        fireEvent.click(mapOf(container), at(20, 30));
        return onPointer.mock.calls.at(-1)[0].metersPerPx;
      };
      const start = size();
      await userEvent.click(screen.getByTitle('Zoom in'));
      const once = size();
      await userEvent.click(screen.getByTitle('Zoom in'));
      const twice = size();
      expect(once).toBeCloseTo(start / 2, 1);
      expect(twice).toBeCloseTo(start / 4, 1);
    });

    it('reports where a mouse is, at most once a frame', async () => {
      const { onPointer, container } = show();
      for (const x of [10, 20, 30, 40, 50]) fireEvent.mouseMove(mapOf(container), at(x, 60));
      expect(onPointer).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(onPointer).toHaveBeenCalledTimes(1));
      // The last place it was.
      expect(onPointer.mock.calls[0][0]).toMatchObject({ type: 'hover', x: 50, y: 60 });
    });

    it('does not report a mouse that is dragging the map', async () => {
      const { onPointer, container } = show();
      fireEvent.mouseMove(mapOf(container), at(10, 10, { buttons: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(onPointer).not.toHaveBeenCalled();
    });

    it('does not report a move the map had already given up on by a click', async () => {
      const { onPointer, container } = show();
      fireEvent.mouseMove(mapOf(container), at(10, 10));
      fireEvent.click(mapOf(container), at(10, 10));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(onPointer.mock.calls.map(([e]) => e.type)).toEqual(['pick']);
    });

    it('says when the mouse leaves the map', () => {
      const { onPointer, container } = show();
      fireEvent.mouseOut(mapOf(container), { relatedTarget: document.body });
      expect(onPointer).toHaveBeenCalledWith({ type: 'leave' });
    });

    it('says when the view is about to change, by a zoom or by Reset view', async () => {
      const { onPointer } = show();
      await userEvent.click(screen.getByTitle('Zoom in'));
      expect(onPointer).toHaveBeenCalledWith({ type: 'move' });
    });

    it('leaves a stop to name itself: nothing is reported while the mouse is over one', async () => {
      const { onPointer, container } = show({ stops: STOPS, stopZoom: 0 });
      const hit = container.querySelectorAll('.leaflet-stops-pane path.leaflet-interactive')[0];
      await userEvent.hover(hit);
      expect(onPointer).toHaveBeenCalledWith({ type: 'leave' });
      onPointer.mockClear();
      fireEvent.mouseMove(mapOf(container), at(10, 10));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(onPointer).not.toHaveBeenCalled();
      // And it picks up again once the mouse is off the stop.
      await userEvent.unhover(hit);
      fireEvent.mouseMove(mapOf(container), at(12, 12));
      await vi.waitFor(() => expect(onPointer).toHaveBeenCalledTimes(1));
      expect(onPointer.mock.calls[0][0].type).toBe('hover');
    });

    it('says whether the screen is a touchscreen', () => {
      const original = window.matchMedia;
      window.matchMedia = (query) => ({
        matches: query === '(pointer: coarse)',
        addEventListener() {},
        removeEventListener() {},
      });
      try {
        const { onPointer, container } = show();
        fireEvent.click(mapOf(container), at(20, 30));
        expect(onPointer.mock.calls[0][0].touch).toBe(true);
      } finally {
        window.matchMedia = original;
      }
    });

    it('is not needed: a map with no onPointer works as before', async () => {
      const { container } = render(<InteractiveMap {...props} />);
      fireEvent.click(mapOf(container), at(20, 30));
      fireEvent.mouseMove(mapOf(container), at(20, 30));
      await userEvent.click(screen.getByTitle('Zoom in'));
      expect(container.querySelector('.leaflet-container')).not.toBeNull();
    });

    it('stops reporting when it goes away, with a move still waiting', async () => {
      const { onPointer, container, unmount } = show();
      fireEvent.mouseMove(mapOf(container), at(10, 10));
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(onPointer).not.toHaveBeenCalled();
    });
  });

  it('names what the zoom cue is about', () => {
    render(<InteractiveMap {...props} stops={STOPS} stopZoom={16} stopsLabel="stations" />);
    expect(screen.getByText('Zoom in to see stations')).toBeInTheDocument();
  });

  it('keeps its layers in a stacking context of their own, below the page’s bars and menus', () => {
    // Leaflet's panes and controls have z-indexes of 400 to 1000; left to the page's
    // stacking context they paint over the fixed tab bar and the Browse menu.
    const { container } = render(<InteractiveMap {...props} />);
    const frame = container.querySelector('.leaflet-container').parentElement;
    expect(frame).toHaveClass('isolate');
  });

  it('removes its map when it goes away', () => {
    const { container, unmount } = render(<InteractiveMap {...props} />);
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
    unmount();
    expect(document.querySelector('.leaflet-container')).toBeNull();
  });
});
