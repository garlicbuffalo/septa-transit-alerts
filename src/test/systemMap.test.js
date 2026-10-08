import { describe, expect, it } from 'vitest';
import { METRO_LINE_ORDER } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER } from '../lib/railLines.js';
import {
  BUS_COLOR,
  buildBusLayer,
  highlightLines,
  MAP_MODE_KEYS,
  METRO_LAYER,
  METRO_LEGEND,
  modesParam,
  parseModes,
  placeCard,
  RAIL_COLOR,
  RAIL_LAYER,
  routesNear,
  SYSTEM_FIT,
  sortRoutes,
  toggleMode,
  visibleLines,
  visibleStops,
} from '../lib/systemMap.js';

const ALL = ['metro', 'bus', 'rail'];
const LINE = [
  [39.95, -75.17],
  [39.96, -75.17],
];
const BUS = buildBusLayer({
  17: [LINE, LINE.map(([lat, lon]) => [lat, lon + 0.01])],
  K: [LINE],
  'L1-OWL': [LINE],
  // Nothing to draw: the route is left out.
  99: [],
});

describe('the Metro and Regional Rail layers', () => {
  it('draw every line from the bundled shapes, in the site’s order', () => {
    expect([...METRO_LAYER.routes.keys()]).toEqual(METRO_LINE_ORDER.map((l) => `metro:${l}`));
    expect([...RAIL_LAYER.routes.keys()]).toEqual(RAIL_LINE_ORDER.map((l) => `rail:${l}`));
    expect(METRO_LAYER.lines.length).toBeGreaterThan(METRO_LAYER.routes.size - 1);
  });

  it('draw the subways over the trolleys, so they win where the two cross', () => {
    const order = [...new Set(METRO_LAYER.lines.map((l) => l.routeId))];
    expect(order.at(-1)).toBe('metro:l1');
    expect(order.indexOf('metro:b1')).toBeGreaterThan(order.indexOf('metro:t1'));
    expect(order.indexOf('metro:l1')).toBeGreaterThan(order.indexOf('metro:b1'));
    expect(order.indexOf('metro:t1')).toBeGreaterThan(order.indexOf('metro:d2'));
    // Each route's lines stay together.
    expect(order).toHaveLength(METRO_LAYER.routes.size);
  });

  it('draw Metro lines in their brand colors and Regional Rail in one color', () => {
    const l1 = METRO_LAYER.lines.find((l) => l.routeId === 'metro:l1');
    expect(l1).toMatchObject({ color: '#0097D6', casing: true, tip: 'L1 Market-Frankford Line' });
    expect(new Set(RAIL_LAYER.lines.map((l) => l.color))).toEqual(new Set([RAIL_COLOR]));
    expect(RAIL_LAYER.lines.find((l) => l.routeId === 'rail:pao').tip).toBe(
      'Paoli/Thorndale Line (Regional Rail)',
    );
  });

  it('link each route to its page', () => {
    expect(METRO_LAYER.routes.get('metro:t3').href).toBe('/line/t3');
    expect(RAIL_LAYER.routes.get('rail:wtr')).toMatchObject({
      href: '/rail/line/wtr',
      label: 'WTR',
    });
  });

  it('give every line a unique id', () => {
    const ids = [...METRO_LAYER.lines, ...RAIL_LAYER.lines].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cover the whole system with the view they start at', () => {
    const [[south, west], [north, east]] = SYSTEM_FIT;
    for (const { points } of [...METRO_LAYER.lines, ...RAIL_LAYER.lines]) {
      for (const [lat, lon] of points) {
        expect(lat).toBeGreaterThanOrEqual(south);
        expect(lat).toBeLessThanOrEqual(north);
        expect(lon).toBeGreaterThanOrEqual(west);
        expect(lon).toBeLessThanOrEqual(east);
      }
    }
  });

  it('have a legend color for each Metro family', () => {
    expect(METRO_LEGEND.map((e) => e.label)).toEqual(['L1', 'B1–B3', 'M1', 'T1–T5', 'G1', 'D1–D2']);
    expect(new Set(METRO_LEGEND.map((e) => e.color)).size).toBe(METRO_LEGEND.length);
  });
});

describe('buildBusLayer', () => {
  it('orders routes the way the site does, with a line for each of a route’s lines', () => {
    expect([...BUS.routes.keys()]).toEqual(['bus:17', 'bus:K', 'bus:L1-OWL']);
    expect(BUS.lines.map((l) => l.id)).toEqual(['bus:17:0', 'bus:17:1', 'bus:K:0', 'bus:L1-OWL:0']);
  });

  it('draws them thin, pale, and without a dark edge', () => {
    expect(BUS.lines[0]).toMatchObject({ color: BUS_COLOR, casing: false });
    expect(BUS.lines[0].weight).toBeLessThan(METRO_LAYER.lines[0].weight);
    expect(BUS.lines[0].opacity).toBeLessThan(1);
  });

  it('names a route by its number and what SEPTA calls it', () => {
    expect(BUS.routes.get('bus:17')).toMatchObject({
      label: '17',
      href: '/route/17',
      tip: 'Route 17 · Front-Mkt to 20-Johnston',
    });
    // SEPTA spells the overnight routes with a space.
    expect(BUS.routes.get('bus:L1-OWL').label).toBe('L1 OWL');
  });

  it('is empty for no routes', () => {
    expect(buildBusLayer(null).lines).toEqual([]);
    expect(buildBusLayer({}).routes.size).toBe(0);
  });
});

describe('visibleLines', () => {
  const layers = { metro: METRO_LAYER, rail: RAIL_LAYER, bus: BUS };
  const modesOf = (lines) => [...new Set(lines.map((l) => l.routeId.split(':')[0]))];

  it('draws buses under Regional Rail under Metro, whatever order the modes come in', () => {
    expect(modesOf(visibleLines(layers, ALL))).toEqual(['bus', 'rail', 'metro']);
    expect(modesOf(visibleLines(layers, ['rail', 'metro']))).toEqual(['rail', 'metro']);
  });

  it('draws only the modes asked for', () => {
    expect(modesOf(visibleLines(layers, ['bus']))).toEqual(['bus']);
    expect(visibleLines(layers, ['metro'])).toHaveLength(METRO_LAYER.lines.length);
  });

  it('draws nothing for a mode whose lines haven’t arrived', () => {
    expect(visibleLines({ ...layers, bus: null }, ['bus'])).toEqual([]);
    expect(modesOf(visibleLines({ ...layers, bus: null }, ALL))).toEqual(['rail', 'metro']);
  });
});

describe('highlightLines', () => {
  const layers = { metro: METRO_LAYER, rail: RAIL_LAYER, bus: BUS };
  const lines = visibleLines(layers, ALL);

  it('draws each of the routes again, wider, in white', () => {
    const extra = highlightLines(lines, ['bus:17', 'metro:l1']);
    const own = lines.filter((l) => l.routeId === 'bus:17' || l.routeId === 'metro:l1');
    expect(extra).toHaveLength(own.length);
    expect(extra.every((l) => l.color === '#ffffff')).toBe(true);
    expect(new Set(extra.map((l) => l.routeId))).toEqual(new Set(['bus:17', 'metro:l1']));
    const bus17 = lines.find((l) => l.routeId === 'bus:17');
    expect(extra.find((l) => l.routeId === 'bus:17').weight).toBeGreaterThan(bus17.weight);
    expect(extra.find((l) => l.routeId === 'bus:17').points).toBe(bus17.points);
  });

  it('gives each a line id of its own', () => {
    const extra = highlightLines(lines, ['bus:17']);
    expect(extra.map((l) => l.id)).toEqual(['selected:bus:17:0', 'selected:bus:17:1']);
  });

  it('has nothing for no routes, or for a route that isn’t drawn', () => {
    expect(highlightLines(lines, [])).toEqual([]);
    expect(highlightLines(visibleLines(layers, ['metro']), ['bus:17'])).toEqual([]);
  });
});

describe('routesNear', () => {
  // Two streets a few blocks apart, a route on each, and a third on the first street.
  const street = (lon) => [
    [39.95, lon],
    [39.96, lon],
  ];
  const lines = [
    { id: 'a:0', routeId: 'a', points: street(-75.17) },
    { id: 'b:0', routeId: 'b', points: street(-75.17) },
    { id: 'c:0', routeId: 'c', points: street(-75.16) },
    // A route with two lines, both near: found once.
    { id: 'd:0', routeId: 'd', points: street(-75.17) },
    { id: 'd:1', routeId: 'd', points: street(-75.1701) },
  ];

  it('finds every route with a line near the point, each once', () => {
    expect(routesNear(lines, 39.955, -75.17, 30).sort()).toEqual(['a', 'b', 'd']);
  });

  it('measures from the point to the line, not to its points', () => {
    // Mid-block: 500 m from either end of the line, and right on it.
    expect(routesNear(lines, 39.955, -75.1701, 30)).toContain('a');
    // 0.0005° of longitude at this latitude is about 43 m.
    expect(routesNear(lines, 39.955, -75.1695, 30)).toEqual([]);
    expect(routesNear(lines, 39.955, -75.1695, 60).sort()).toEqual(['a', 'b', 'd']);
  });

  it('finds the other street, and none where there are no lines', () => {
    expect(routesNear(lines, 39.955, -75.16, 30)).toEqual(['c']);
    expect(routesNear(lines, 39.955, -75.165, 30)).toEqual([]);
    expect(routesNear(lines, 40.5, -75.17, 30)).toEqual([]);
  });

  it('stops at a line’s ends', () => {
    expect(routesNear(lines, 39.9505, -75.17, 30)).toContain('a');
    // 100 m past the end of the street.
    expect(routesNear(lines, 39.949, -75.17, 30)).toEqual([]);
  });

  it('finds the routes where the real Metro and Regional Rail lines run', () => {
    const real = visibleLines({ metro: METRO_LAYER, rail: RAIL_LAYER }, ALL);
    const [lat, lon] = METRO_LAYER.lines.find((l) => l.routeId === 'metro:l1').points[3];
    expect(routesNear(real, lat, lon, 15)).toContain('metro:l1');
    expect(routesNear(real, 0, 0, 15)).toEqual([]);
  });

  it('copes with a line of one point, or none', () => {
    const odd = [
      { id: 'x:0', routeId: 'x', points: [[39.955, -75.17]] },
      { id: 'y:0', routeId: 'y', points: [] },
    ];
    expect(routesNear(odd, 39.955, -75.17, 30)).toEqual([]);
  });
});

describe('sortRoutes', () => {
  it('lists Metro, then Regional Rail, then buses, each in the site’s order', () => {
    const routes = [
      BUS.routes.get('bus:K'),
      RAIL_LAYER.routes.get('rail:pao'),
      BUS.routes.get('bus:17'),
      METRO_LAYER.routes.get('metro:t1'),
      RAIL_LAYER.routes.get('rail:air'),
      METRO_LAYER.routes.get('metro:l1'),
    ];
    expect(sortRoutes(routes).map((r) => r.id)).toEqual([
      'metro:l1',
      'metro:t1',
      'rail:air',
      'rail:pao',
      'bus:17',
      'bus:K',
    ]);
  });

  it('does not change the list it is given', () => {
    const routes = [BUS.routes.get('bus:K'), BUS.routes.get('bus:17')];
    sortRoutes(routes);
    expect(routes.map((r) => r.id)).toEqual(['bus:K', 'bus:17']);
  });
});

describe('placeCard', () => {
  const frame = { width: 800, height: 600 };
  const card = { w: 200, h: 100 };

  it('puts the card beside the point, to its right and under it', () => {
    expect(placeCard({ x: 100, y: 100, ...frame }, card)).toEqual({ left: 114, top: 114 });
  });

  it('puts it to the left, and over the point, where there is no room', () => {
    expect(placeCard({ x: 700, y: 500, ...frame }, card)).toEqual({ left: 486, top: 386 });
  });

  it('keeps it inside the frame', () => {
    const near = placeCard({ x: 5, y: 5, ...frame }, card);
    expect(near.left).toBeGreaterThanOrEqual(6);
    expect(near.top).toBeGreaterThanOrEqual(6);
    // A frame too narrow to have room on either side of the point still holds the card.
    const narrow = placeCard({ x: 150, y: 50, width: 300, height: 600 }, card);
    expect(narrow.left).toBeGreaterThanOrEqual(6);
    expect(narrow.left + card.w).toBeLessThanOrEqual(300 - 6);
  });

  it('never covers the point with the card when there is room on a side', () => {
    for (const [x, y] of [
      [100, 100],
      [700, 100],
      [100, 500],
      [700, 500],
      [400, 300],
    ]) {
      const { left, top } = placeCard({ x, y, ...frame }, card);
      const covers = x >= left && x <= left + card.w && y >= top && y <= top + card.h;
      expect(covers).toBe(false);
    }
  });

  it('keeps clear of the part of the frame that is out of sight', () => {
    // The bottom 150 px are under a tab bar: a card for a point at y 300 goes over it.
    const out = placeCard({ x: 100, y: 440, ...frame }, { ...card, hiddenBelow: 150 });
    expect(out.top + card.h).toBeLessThanOrEqual(600 - 150 - 6);
    expect(out.top).toBe(326);
  });

  it('shrinks to nothing rather than going off the top of a frame that is too short', () => {
    const { top } = placeCard({ x: 50, y: 50, width: 800, height: 80 }, card);
    expect(top).toBe(6);
  });
});

describe('visibleStops', () => {
  it('lists the stations of the Metro and Regional Rail modes, and none for buses', () => {
    const metro = visibleStops(['metro']);
    const rail = visibleStops(['rail']);
    expect(metro.length).toBeGreaterThan(100);
    expect(rail.length).toBeGreaterThan(100);
    expect(visibleStops(['bus'])).toEqual([]);
    expect(visibleStops(ALL)).toHaveLength(metro.length + rail.length);
  });

  it('lists a Regional Rail station that several lines share once', () => {
    const rail = visibleStops(['rail']);
    expect(rail.filter((s) => s.name === 'Suburban Station')).toHaveLength(1);
    expect(new Set(rail.map((s) => s.id)).size).toBe(rail.length);
  });
});

describe('toggleMode', () => {
  it('narrows to one mode from All', () => {
    expect(toggleMode(ALL, 'rail')).toEqual(['rail']);
    expect(toggleMode(ALL, 'metro')).toEqual(['metro']);
  });

  it('adds a second mode, in the map’s order', () => {
    expect(toggleMode(['rail'], 'metro')).toEqual(['metro', 'rail']);
    expect(toggleMode(['bus'], 'rail')).toEqual(['bus', 'rail']);
  });

  it('takes a mode away', () => {
    expect(toggleMode(['metro', 'rail'], 'metro')).toEqual(['rail']);
  });

  it('goes back to every mode when the last one is cleared, not to an empty map', () => {
    expect(toggleMode(['bus'], 'bus')).toEqual(ALL);
  });

  it('lets any combination of two modes be reached', () => {
    for (const a of MAP_MODE_KEYS) {
      for (const b of MAP_MODE_KEYS.filter((k) => k !== a)) {
        expect(toggleMode(toggleMode(ALL, a), b)).toEqual(
          MAP_MODE_KEYS.filter((k) => k === a || k === b),
        );
      }
    }
  });

  it('ignores a mode it doesn’t know', () => {
    expect(toggleMode(['rail'], 'ferry')).toEqual(['rail']);
  });
});

describe('the modes in the URL', () => {
  it('shows every mode with no param', () => {
    expect(parseModes('')).toEqual(ALL);
    expect(parseModes('?other=1')).toEqual(ALL);
  });

  it('reads one or more modes, in the map’s order, once each', () => {
    expect(parseModes('?modes=rail')).toEqual(['rail']);
    expect(parseModes('?modes=rail,metro')).toEqual(['metro', 'rail']);
    expect(parseModes('?modes=bus,bus')).toEqual(['bus']);
    expect(parseModes('?modes=%20Metro%20,BUS')).toEqual(['metro', 'bus']);
  });

  it('understands the other spellings of a mode', () => {
    expect(parseModes('?modes=regional_rail')).toEqual(['rail']);
    expect(parseModes('?modes=buses,regional-rail')).toEqual(['bus', 'rail']);
  });

  it('shows every mode when none is recognized, rather than an empty map', () => {
    expect(parseModes('?modes=')).toEqual(ALL);
    expect(parseModes('?modes=ferry')).toEqual(ALL);
  });

  it('keeps the modes it does recognize when others are not', () => {
    expect(parseModes('?modes=ferry,rail')).toEqual(['rail']);
  });

  it('leaves the param off when every mode is showing', () => {
    expect(modesParam(ALL)).toBeNull();
    expect(modesParam(['rail', 'bus', 'metro'])).toBeNull();
    expect(modesParam(['rail', 'metro'])).toBe('metro,rail');
    expect(modesParam(['bus'])).toBe('bus');
  });

  it('round-trips', () => {
    for (const modes of [['metro'], ['bus', 'rail'], ['metro', 'rail'], ALL]) {
      const param = modesParam(modes);
      expect(parseModes(param == null ? '' : `?modes=${param}`)).toEqual(modes);
    }
  });
});
