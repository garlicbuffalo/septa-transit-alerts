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

  it('redraws and refits when its lines change', () => {
    const { container, rerender } = render(<InteractiveMap {...props} />);
    rerender(
      <InteractiveMap
        {...props}
        lines={[{ id: 'c', points: ROUTE, color: '#2ad17f' }]}
        dots={[]}
      />,
    );
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(2);
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

  it('removes its map when it goes away', () => {
    const { container, unmount } = render(<InteractiveMap {...props} />);
    expect(container.querySelector('.leaflet-container')).not.toBeNull();
    unmount();
    expect(document.querySelector('.leaflet-container')).toBeNull();
  });
});
