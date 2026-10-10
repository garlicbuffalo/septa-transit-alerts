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

describe('screenVehicles: a frozen fix', () => {
  // A trolley that went into the tunnel: the tracker repeats its last position, to the last
  // decimal, with fresh reports. Ticks a minute apart unless a test says otherwise.
  const at0 = at(0);
  const run = (readings, { mode = 'metro', every = MIN, shapes: s = null } = {}) => {
    let state = {};
    return readings.map((pos, n) => {
      const now = NOW + n * every;
      const out = screenVehicles([vehicle({ mode, tripId: null, ...pos, reportTs: now })], {
        shapes: s,
        prev: state,
        now,
      });
      state = out.state;
      return out;
    });
  };
  const frozenFlags = (outs) => outs.map((o) => o.vehicles[0]?.frozen === true);

  it('is flagged once the position has repeated for frozenMs, and not before', () => {
    const outs = run([at0, at0, at0, at0, at0]);
    // Seen at minute 0; identical at 1 and 2 (under 3 minutes); frozen from minute 3.
    expect(frozenFlags(outs)).toEqual([false, false, false, true, true]);
    expect(outs.map((o) => o.frozen)).toEqual([0, 0, 0, 1, 1]);
    expect(SCREEN_CONFIG.frozenMs).toBe(3 * MIN);
  });

  it('keeps the vehicle (it is flagged, not dropped), as a copy', () => {
    const [, , , out] = run([at0, at0, at0, at0]);
    expect(out.vehicles).toHaveLength(1);
    expect(out.vehicles[0]).toMatchObject({ id: '9066', frozen: true, lat: at0.lat });
    expect(out.dropped).toEqual({ offRoute: 0, jump: 0 });
  });

  it('is never flagged for a vehicle whose fix wobbles, as a real stop does', () => {
    const wobble = Array.from({ length: 10 }, (_, i) => at(i % 2 ? 4 : 0 + i * 0.3));
    expect(frozenFlags(run(wobble)).some(Boolean)).toBe(false);
  });

  it('is only for trolleys, since only they go underground', () => {
    expect(frozenFlags(run([at0, at0, at0, at0, at0], { mode: 'bus' }))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('clears when the vehicle moves, and starts counting again from there', () => {
    const moved = at(40);
    const outs = run([at0, at0, at0, at0, moved, moved, moved, moved]);
    expect(frozenFlags(outs)).toEqual([false, false, false, true, false, false, false, true]);
  });

  it('is judged by time, so a collector polling every 10 minutes flags a single repeat', () => {
    expect(frozenFlags(run([at0, at0, at0], { every: 10 * MIN }))).toEqual([false, true, true]);
  });

  describe('coming out of the tunnel', () => {
    // 3.5 km on in the next minute: fast for a trolley, but from a fix it never measured.
    const emerged = at(3500);

    it('is not a jump from the frozen fix', () => {
      const outs = run([at0, at0, at0, at0, emerged]);
      expect(outs[4].vehicles).toHaveLength(1);
      expect(outs[4].vehicles[0].frozen).toBeUndefined();
      expect(outs[4].dropped.jump).toBe(0);
    });

    it('is a jump from a fix that was being measured', () => {
      const wobble = [at(0), at(2), at(0.5), at(1.5)];
      const outs = run([...wobble, emerged]);
      expect(outs[4].vehicles).toHaveLength(0);
      expect(outs[4].dropped.jump).toBe(1);
    });

    it('is still dropped if it is off its trip’s shape', () => {
      // The City Ave fix: nowhere near the line the trip runs.
      const stray = { lat: at0.lat + 0.049, lon: at0.lon - 0.039 };
      const onTrip = { tripShape: () => trunk };
      let state = {};
      for (let n = 0; n < 4; n++) {
        state = screenVehicles(
          [vehicle({ mode: 'metro', tripId: 'trunk-1', reportTs: NOW + n * MIN })],
          {
            shapes: onTrip,
            prev: state,
            now: NOW + n * MIN,
          },
        ).state;
      }
      const out = screenVehicles(
        [vehicle({ mode: 'metro', tripId: 'trunk-1', ...stray, reportTs: NOW + 4 * MIN })],
        { shapes: onTrip, prev: state, now: NOW + 4 * MIN },
      );
      expect(out.dropped.offRoute).toBe(1);
    });
  });

  it('is remembered in state that is plain JSON, from a call to the next', () => {
    const [, , out] = run([at0, at0, at0]);
    const state = JSON.parse(JSON.stringify(out.state));
    expect(state['9066']).toMatchObject({ lat: at0.lat, since: NOW, seen: NOW + 2 * MIN });
    const next = screenVehicles(
      [vehicle({ mode: 'metro', tripId: null, reportTs: NOW + 3 * MIN })],
      {
        prev: state,
        now: NOW + 3 * MIN,
      },
    );
    expect(next.vehicles[0].frozen).toBe(true);
  });
});
