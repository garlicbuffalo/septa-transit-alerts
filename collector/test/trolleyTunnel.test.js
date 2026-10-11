// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildScheduleIndex, Schedule } from '../lib/schedule.js';
import { easternToEpoch } from '../lib/time.js';
import { placeTunnelTrolleys, tunnelTrouble } from '../lib/trolleyTunnel.js';

// Sunday, Oct 11, 2026, in Philadelphia.
const at = (h, m, s = 0) => easternToEpoch(2026, 10, 11, h, m, s);

// A T3 round trip through the tunnel, timed like the ones recorded on 2026-10-11: in at the 40th
// St Portal at 8:54, 13th St at 9:05, back out from 9:06 to the portal at 9:16.
const files = {
  'trips.txt':
    'route_id,service_id,trip_id,trip_headsign,direction_id\nT3,sun,e1,13th-Market,0\nT3,sun,w1,Yeadon,1\nT3,sun,e2,13th-Market,0\n',
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'e1,08:52:00,08:52:00,ch,30',
    'e1,08:54:00,08:54:00,p0,31',
    'e1,08:55:36,08:55:36,sp,32',
    'e1,08:58:16,08:58:16,rd,34',
    'e1,09:05:00,09:05:00,th,39',
    'w1,09:06:00,09:06:00,th,1',
    'w1,09:12:00,09:12:00,rd,6',
    'w1,09:14:35,09:14:35,sp,8',
    'w1,09:16:00,09:16:00,p1,9',
    'w1,09:17:00,09:17:00,ch,10',
    'e2,09:12:00,09:12:00,ch,30',
    'e2,09:14:00,09:14:00,p0,31',
    'e2,09:15:36,09:15:36,sp,32',
    'e2,09:18:16,09:18:16,rd,34',
    'e2,09:25:00,09:25:00,th,39',
    '',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'ch,Chester Av & 42nd St,39.94842,-75.20715',
    'p0,40th St Portal,39.94953,-75.20333',
    'p1,40th St Portal,39.94960,-75.20333',
    'sp,37th-Spruce,39.95099,-75.19659',
    'rd,33rd St,39.95478,-75.18952',
    'th,13th St,39.95253,-75.16256',
    '',
  ].join('\n'),
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsun,0,0,0,0,0,0,1,20260901,20261231\n',
};
const zip = { read: (name) => Buffer.from(files[name] ?? '') };
const schedule = Schedule.from(buildScheduleIndex(zip, at(8, 0)));

// SEPTA's point for a trolley under the 40th St Portal.
const PARKED = { lat: 39.949818, lon: -75.20215 };

const trolley = (over = {}) => ({
  id: '9082',
  label: '9082',
  mode: 'metro',
  route: 't3',
  tripId: 'e1',
  directionName: 'EastBound',
  destination: '13th-Market',
  ...PARKED,
  heading: null,
  lateMin: 4,
  nextStopSequence: 31,
  nextStopName: null,
  reportTs: at(8, 57, 41),
  ...over,
});

/** Run polls in order: [[now, vehicles], …] → each poll's output for vehicle `id`. */
function run(polls, { id = '9082', trouble } = {}) {
  let state = {};
  return polls.map(([now, vehicles]) => {
    const r = placeTunnelTrolleys(vehicles, { schedule, state, now, trouble });
    state = r.state;
    return { v: r.vehicles.find((x) => x.id === id) ?? null, stats: r.stats, state };
  });
}

describe('the tunnel in the schedule index', () => {
  it("keeps only the trolleys' stops in the tunnel", () => {
    expect(schedule.stopTimes('e1').stops.map((s) => s.name)).toEqual([
      '40th St Portal',
      '37th-Spruce',
      '33rd St',
      '13th St',
    ]);
    expect(schedule.stopTimes('w1').stops.map((s) => [s.name, s.seq])).toEqual([
      ['13th St', 1],
      ['33rd St', 6],
      ['37th-Spruce', 8],
      ['40th St Portal', 9],
    ]);
  });
});

describe('trolleys in the tunnel', () => {
  it('leaves a trolley with a working fix at the portal where it is', () => {
    const [, second] = run([
      [at(8, 57, 50), [trolley({ lat: 39.94951, lon: -75.20341, reportTs: at(8, 57, 45) })]],
      [at(8, 58, 50), [trolley({ lat: 39.94953, lon: -75.20338, reportTs: at(8, 58, 44) })]],
    ]);
    expect(second.v.estimated).toBeUndefined();
    expect(second.v.lat).toBe(39.94953);
  });

  it('places one whose fix has stopped at the portal by its trip, as late as it went in', () => {
    const [first, second] = run([
      [at(8, 58, 0), [trolley({ lateMin: 4 })]],
      [at(8, 58, 50), [trolley({ lateMin: 5, reportTs: at(8, 58, 30) })]],
    ]);
    expect(first.v.estimated).toBeUndefined(); // seen once: not yet
    expect(second.v).toMatchObject({
      estimated: true,
      tripId: 'e1',
      directionName: 'EastBound',
      nextStopName: '37th-Spruce',
      nextStopSequence: 32,
      // It went in at 8:57:41 for 8:54: 3.7 min late, not TransitView's growing 5.
      lateMin: 3.7,
    });
    expect(second.v.lon).toBeGreaterThan(-75.2033);
    expect(second.v.lon).toBeLessThan(-75.1966);
    expect(second.stats).toMatchObject({ underground: 1, placed: 1 });
  });

  it('takes it through to 13th St and back out on its next trip', () => {
    const polls = [
      [at(8, 58, 0), [trolley()]],
      [at(8, 59, 0), [trolley()]],
      // Due at 13th St at 9:05, 3.7 min late: still on its way.
      [at(9, 7, 0), [trolley()]],
      // TransitView has moved it on to its 9:06 departure.
      [at(9, 10, 0), [trolley({ tripId: 'w1', directionName: 'WestBound', lateMin: 0 })]],
      // Due out at 9:16 + 2.7: it should be out, and isn't.
      [at(9, 22, 0), [trolley({ tripId: 'w1', directionName: 'WestBound', lateMin: 9 })]],
    ];
    const out = run(polls).map((x) => x.v);
    expect(out[2]).toMatchObject({ tripId: 'e1', nextStopName: '13th St', lateMin: 3.7 });
    // Arrived 9:08:41, out at once: 2.7 min behind its 9:06 departure.
    expect(out[3]).toMatchObject({
      estimated: true,
      tripId: 'w1',
      directionName: 'WestBound',
      destination: 'Chester Av & 42nd St',
      nextStopName: '33rd St',
      lateMin: 2.7,
    });
    expect(out[3].frozen).toBeUndefined();
    // Overdue: held at the portal, position unknown, and as late as that makes it.
    expect(out[4]).toMatchObject({ estimated: true, frozen: true, nextStopName: '40th St Portal' });
    expect(out[4].lateMin).toBe(6);
  });

  it('gives up on one underground far longer than the tunnel takes', () => {
    const out = run([
      [at(8, 58, 0), [trolley()]],
      [at(8, 59, 0), [trolley()]],
      [at(9, 50, 0), [trolley()]],
    ]);
    expect(out[1].v.estimated).toBe(true);
    expect(out[2].v.estimated).toBeUndefined();
    expect(out[2].stats.lost).toBe(1);
  });

  it('places a trolley as soon as it lands on the point SEPTA parks them at', () => {
    const other = (over) => trolley({ id: '9080', label: '9080', tripId: 'e2', ...over });
    const polls = [
      // 9082 freezes there: the point is learned.
      [at(8, 58, 0), [trolley()]],
      [at(8, 59, 0), [trolley()]],
      // 9080 comes up to the portal with a working fix…
      [
        at(9, 13, 30),
        [trolley(), other({ lat: 39.94951, lon: -75.20341, reportTs: at(9, 13, 25), lateMin: -1 })],
      ],
      // …and lands on the point (a few meters off 9082's).
      [
        at(9, 14, 0),
        [
          trolley(),
          other({ lat: 39.949818, lon: -75.20212, reportTs: at(9, 13, 55), lateMin: -1 }),
        ],
      ],
    ];
    const out = run(polls, { id: '9080' });
    expect(out[2].v.estimated).toBeUndefined();
    expect(out[3].v).toMatchObject({ estimated: true, tripId: 'e2' });
    // In between its last fix outside (9:13:25) and this one (9:13:55), for 9:14.
    expect(out[3].v.lateMin).toBe(-0.3);
  });

  it('keeps a trolley underground as its fix settles onto the parked point', () => {
    const out = run([
      [at(8, 58, 0), [trolley({ lat: 39.949776, lon: -75.202043 })]],
      [at(8, 59, 0), [trolley({ lat: 39.949776, lon: -75.202043 })]],
      [at(9, 0, 0), [trolley({ reportTs: at(8, 59, 50) })]],
    ]);
    expect(out[1].v.estimated).toBe(true);
    expect(out[2].v).toMatchObject({ estimated: true, lateMin: 3.7 });
  });

  it("doesn't place one SEPTA's tracker can't match to its schedule (a GPS stuck at the portal)", () => {
    const out = run([
      [at(8, 58, 0), [trolley({ lateMin: null })]],
      [at(8, 59, 0), [trolley({ lateMin: null })]],
    ]);
    expect(out[1].v.estimated).toBeUndefined();
    expect(out[1].stats.lost).toBe(1);
  });

  it("doesn't place trolleys on a line with an alert about the tunnel", () => {
    const out = run(
      [
        [at(8, 58, 0), [trolley()]],
        [at(8, 59, 0), [trolley()]],
      ],
      { trouble: new Set(['t3']) },
    );
    expect(out[1].v.estimated).toBeUndefined();
    expect(out[1].stats.trouble).toBe(1);
    const alert = (headline, routes = ['t3']) => [
      headline,
      {
        mode: 'metro',
        routes,
        lifecycle: { active: true },
        official_alert: { headline, description: null },
      },
    ];
    expect(
      tunnelTrouble(
        new Map([
          alert('Trolleys diverting to 40th St Portal'),
          alert('T2 delays due to a disabled trolley', ['t2']),
        ]),
      ),
    ).toEqual(new Set(['t3']));
  });

  it('places one TransitView has dropped from memory', () => {
    const out = run([
      [at(8, 58, 0), [trolley()]],
      [at(8, 59, 0), [trolley()]],
      [at(9, 1, 0), []],
    ]);
    expect(out[2].v).toMatchObject({ estimated: true, tripId: 'e1' });
    expect(out[2].stats.remembered).toBe(1);
  });

  it('keeps the newer trip of a trolley TransitView lists twice', () => {
    const out = run([
      [at(9, 5, 0), [trolley()]],
      [at(9, 6, 0), [trolley(), trolley({ tripId: 'w1', directionName: 'WestBound', lateMin: 0 })]],
    ]);
    expect(out[1].v.tripId).toBe('e1'); // still on its way to 13th St
    expect(out[1].stats.underground).toBe(1);
  });
});
