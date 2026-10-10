import { describe, expect, it } from 'vitest';
import { SCREEN_CONFIG, screenVehicles } from '../lib/vehicleScreen.js';

const NOW = Date.UTC(2026, 9, 9, 14, 12);
const MIN = 60 * 1000;
const M_PER_DEG_LAT = 111_320;

// A position `north` meters north of the 40th St Portal.
const at = (north = 0) => ({ lat: 39.9499 + north / M_PER_DEG_LAT, lon: -75.2017 });

const vehicle = (over = {}) => ({
  id: '9066',
  label: '9066',
  tripId: '971916',
  ...at(0),
  reportTs: NOW,
  ...over,
});

// A trip's shape: a straight line running north through the portal for 12 km, and an
// extension of the same route a few km west that only some trips run.
const trunk = [
  [39.9, -75.2017],
  [40.0, -75.2017],
];
const extension = [
  [39.95, -75.28],
  [40.0, -75.28],
];
const shapes = {
  tripShape: (tripId) => ({ trunk, ext: extension })[tripId.split('-')[0]] ?? null,
};

const screen = (vehicles, over = {}) => screenVehicles(vehicles, { shapes, now: NOW, ...over });

describe('screenVehicles: off route', () => {
  it('keeps a vehicle on its own trip’s shape and drops one far from it', () => {
    const onRoute = vehicle({ id: 'a', tripId: 'trunk-1' });
    // 6 km west: where City Ave is, from the portal.
    const stray = vehicle({ id: 'b', tripId: 'trunk-2', lon: -75.2017 - 0.07 });
    const out = screen([onRoute, stray]);
    expect(out.vehicles.map((v) => v.id)).toEqual(['a']);
    expect(out.dropped).toEqual({ offRoute: 1, jump: 0 });
  });

  it('judges a vehicle by its own trip, so one on an extension is kept', () => {
    // 7 km from the trunk (the route's busiest shape), but on its own trip's shape.
    const onExtension = vehicle({ tripId: 'ext-1', lat: 39.97, lon: -75.28 });
    expect(screen([onExtension]).vehicles).toHaveLength(1);
    // The same position on a trip that runs the trunk is wrong.
    expect(screen([{ ...onExtension, tripId: 'trunk-1' }]).dropped.offRoute).toBe(1);
  });

  it('allows a detour or a terminal loop, up to maxOffRouteM', () => {
    const near = vehicle({ tripId: 'trunk-1', lon: -75.2017 + 1200 / 85_300 });
    const far = vehicle({ tripId: 'trunk-1', lon: -75.2017 + 1800 / 85_300 });
    expect(screen([near]).vehicles).toHaveLength(1);
    expect(screen([far]).vehicles).toHaveLength(0);
    expect(SCREEN_CONFIG.maxOffRouteM).toBe(1500);
  });

  it('keeps a vehicle whose trip it has no shape for, or without a trip, or with no shapes at all', () => {
    const stray = { lat: 40.5, lon: -76 };
    expect(screen([vehicle({ tripId: 'unknown-1', ...stray })]).vehicles).toHaveLength(1);
    expect(screen([vehicle({ tripId: null, ...stray })]).vehicles).toHaveLength(1);
    expect(
      screen([vehicle({ tripId: 'trunk-1', ...stray })], { shapes: null }).vehicles,
    ).toHaveLength(1);
  });
});

describe('screenVehicles: jumps', () => {
  const first = screen([vehicle({ tripId: null })]);

  it('drops a position that is faster than a vehicle goes from the last one kept', () => {
    // 6 km in a minute: 360 km/h.
    const out = screen([vehicle({ tripId: null, ...at(6000), reportTs: NOW + MIN })], {
      prev: first.state,
      now: NOW + MIN,
    });
    expect(out.vehicles).toEqual([]);
    expect(out.dropped).toEqual({ offRoute: 0, jump: 1 });
  });

  it('keeps the last good position, so the next reading is judged against it', () => {
    const out = screen([vehicle({ tripId: null, ...at(6000), reportTs: NOW + MIN })], {
      prev: first.state,
      now: NOW + MIN,
    });
    expect(out.state['9066']).toMatchObject({ lat: at(0).lat, lon: at(0).lon, reportTs: NOW });
  });

  it('keeps ordinary movement and GPS noise', () => {
    // A bus at 50 km/h, and one that is standing still with a 300 m wobble.
    const drive = screen([vehicle({ tripId: null, ...at(800), reportTs: NOW + MIN })], {
      prev: first.state,
      now: NOW + MIN,
    });
    const wobble = screen([vehicle({ tripId: null, ...at(300), reportTs: NOW + 5000 })], {
      prev: first.state,
      now: NOW + 5000,
    });
    expect(drive.vehicles).toHaveLength(1);
    expect(wobble.vehicles).toHaveLength(1);
  });

  it('does not count a long way in a long time, or after a long silence', () => {
    // 6 km in 10 minutes is 36 km/h; and reports more than 5 minutes apart say nothing.
    const slow = screen([vehicle({ tripId: null, ...at(6000), reportTs: NOW + 10 * MIN })], {
      prev: first.state,
      now: NOW + 10 * MIN,
    });
    expect(slow.vehicles).toHaveLength(1);
    const silent = screen([vehicle({ tripId: null, ...at(60_000), reportTs: NOW + 6 * MIN })], {
      prev: first.state,
      now: NOW + 6 * MIN,
    });
    expect(silent.vehicles).toHaveLength(1);
  });

  it('treats two reports with the same timestamp as at least 30 seconds apart', () => {
    // 2 km at the same instant is 240 km/h; 1.4 km is under the jump size.
    const prev = first.state;
    expect(screen([vehicle({ tripId: null, ...at(2000) })], { prev }).dropped.jump).toBe(1);
    expect(screen([vehicle({ tripId: null, ...at(1400) })], { prev }).dropped.jump).toBe(0);
  });

  it('judges each vehicle against its own history', () => {
    const both = screen([
      vehicle({ id: 'a', tripId: null }),
      vehicle({ id: 'b', tripId: null, ...at(9000) }),
    ]);
    const out = screen(
      [
        vehicle({ id: 'a', tripId: null, ...at(300), reportTs: NOW + MIN }),
        vehicle({ id: 'b', tripId: null, ...at(9300), reportTs: NOW + MIN }),
      ],
      { prev: both.state, now: NOW + MIN },
    );
    expect(out.vehicles.map((v) => v.id)).toEqual(['a', 'b']);
  });
});

describe('screenVehicles: a vehicle whose position keeps changing', () => {
  // Reports alternating between two places 15 km apart, as bus 7302’s did for hours.
  const report = (n, north) =>
    vehicle({ tripId: null, ...at(north), reportTs: NOW + n * MIN, id: '7302' });
  const run = (norths) => {
    let state = {};
    return norths.map((north, n) => {
      const out = screenVehicles([report(n, north)], {
        shapes: null,
        prev: state,
        now: NOW + n * MIN,
      });
      state = out.state;
      return out.vehicles.length === 1;
    });
  };

  it('never believes the position that alternates with the one it had', () => {
    const A = 0;
    const B = 15_000;
    expect(run([A, B, A, B, A, B, A, B, A])).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('believes a new position once it has held for reanchorAfter reports in a row', () => {
    // Moves 15 km and stays there (a few hundred meters of drift between reports).
    const B = [15_000, 15_300, 15_600, 15_900, 16_200];
    expect(run([0, ...B])).toEqual([true, false, false, true, true, true]);
    expect(SCREEN_CONFIG.reanchorAfter).toBe(3);
  });
});

describe('screenVehicles: state and one tick’s duplicates', () => {
  it('is plain JSON, and the next call reads it back', () => {
    const out = screen([vehicle({ tripId: null })]);
    const roundTripped = JSON.parse(JSON.stringify(out.state));
    expect(roundTripped).toEqual(out.state);
    const next = screen([vehicle({ tripId: null, ...at(6000), reportTs: NOW + MIN })], {
      prev: roundTripped,
      now: NOW + MIN,
    });
    expect(next.dropped.jump).toBe(1);
  });

  it('forgets a vehicle that has not reported for keepMs', () => {
    const out = screen([vehicle({ tripId: null })]);
    const later = NOW + SCREEN_CONFIG.keepMs + 1;
    expect(screen([], { prev: out.state, now: later }).state).toEqual({});
    expect(screen([], { prev: out.state, now: NOW + MIN }).state).toHaveProperty('9066');
  });

  it('keeps the good position when one tick lists a vehicle twice, in either order', () => {
    const prev = screen([vehicle({ tripId: null })]).state;
    const good = vehicle({ tripId: null, ...at(300), reportTs: NOW + MIN });
    const bad = vehicle({ tripId: null, ...at(163_000), reportTs: NOW + MIN });
    for (const list of [
      [good, bad],
      [bad, good],
    ]) {
      const out = screen(list, { prev, now: NOW + MIN });
      expect(out.vehicles).toEqual([good]);
      expect(out.state['9066']).toMatchObject({ lat: good.lat, reportTs: NOW + MIN });
      expect(out.state['9066'].pending).toBeUndefined();
    }
  });

  it('leaves the vehicles it is given untouched and in order', () => {
    const list = [vehicle({ id: 'a', tripId: 'trunk-1' }), vehicle({ id: 'b', tripId: 'trunk-2' })];
    const out = screen(list);
    expect(out.vehicles).toEqual(list);
    expect(out.vehicles[0]).toBe(list[0]);
  });
});
