import { describe, expect, it } from 'vitest';
import {
  CONFIRM_MS,
  composePccPost,
  fetchTrackerStats,
  fetchTrackerStatus,
  isPccLabel,
  LOST_MS,
  maybePostPcc,
  pccFromVehicles,
  statsLine,
  trackSightings,
} from '../features/pcc.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { fakeShapes, testPoster, vehicle } from './helpers.js';

// Saturday, Oct 10, 2026, in Philadelphia (UTC−4).
const at = (h, m) => Date.UTC(2026, 9, 10, h + 4, m);
const TODAY = '2026-10-10';
const basemap = createBasemap();

const G1_LINE = [
  [39.9727, -75.2463],
  [39.9711, -75.1577],
  [39.9842, -75.0998],
];
const shapes = fakeShapes({ g1: G1_LINE });

const g1 = (label, over = {}) =>
  vehicle({
    id: label,
    label,
    mode: 'metro',
    route: 'g1',
    directionName: 'Eastbound',
    destination: 'Richmond-Westmoreland',
    lat: 39.9719,
    lon: -75.1635,
    nextStopName: 'Girard Av & 16th St',
    ...over,
  });

function trackerStatus(cars, busCount = 7) {
  return {
    updatedAt: '2026-10-10T12:00:00.000Z',
    pccCount: cars.length,
    busCount,
    vehicles: cars.map(([id, direction, destination]) => ({
      id,
      direction,
      destination,
      lateMinutes: 0,
    })),
  };
}

const STATS = {
  vehicleAllTime: [
    { vehicleId: '2324', daysActive: 102, firstSeen: '2026-02-09', lastSeen: '2026-10-09' },
    { vehicleId: '2337', daysActive: 73, firstSeen: '2026-01-18', lastSeen: '2026-10-10' },
  ],
};

/** A fetch stand-in serving the tracker's two feeds; `status` is read on every call. */
function fakeTracker(state) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (state.down) throw new Error('fetch failed');
    const body = url.includes('widget-status') ? state.status : STATS;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchFn, calls };
}

describe('PCC cars', () => {
  it('are 4-digit fleet numbers starting 23', () => {
    expect(isPccLabel('2324')).toBe(true);
    expect(isPccLabel(' 2337 ')).toBe(true);
    expect(isPccLabel('3676')).toBe(false);
    expect(isPccLabel('232')).toBe(false);
    expect(isPccLabel('23240')).toBe(false);
    expect(isPccLabel(null)).toBe(false);
  });

  it("read the tracker's status and stats feeds", async () => {
    const { fetchFn, calls } = fakeTracker({
      status: trackerStatus([
        ['2324', 'Eastbound', 'Richmond-Westmoreland'],
        ['9999', 'Unknown', ''],
      ]),
    });
    const status = await fetchTrackerStatus({ fetchFn });
    expect(status).toEqual({
      cars: [{ id: '2324', direction: 'Eastbound', destination: 'Richmond-Westmoreland' }],
      buses: 7,
      updatedAt: Date.parse('2026-10-10T12:00:00.000Z'),
    });
    expect(calls[0]).toBe(
      'https://septa-g-trolley-tracker.netlify.app/.netlify/functions/widget-status',
    );
    const stats = await fetchTrackerStats({ fetchFn });
    expect(stats.get('2324')).toEqual({
      daysActive: 102,
      firstSeen: '2026-02-09',
      lastSeen: '2026-10-09',
    });
  });

  it("fall back to SEPTA's own G1 positions", () => {
    const status = pccFromVehicles([
      g1('2324', { directionName: 'Westbound', destination: '63rd-Girard' }),
      g1('3676'),
      g1('3400'),
      vehicle({ label: '2330', route: '23' }), // a bus on another route
    ]);
    expect(status).toEqual({
      cars: [{ id: '2324', direction: 'Westbound', destination: '63rd-Girard' }],
      buses: 2,
    });
  });
});

describe('sightings', () => {
  it('confirm a car seen continuously for a few minutes', () => {
    const t = at(7, 0);
    let r = trackSightings(null, ['2324'], { now: t, date: TODAY });
    expect(r.confirmed).toEqual([]);
    r = trackSightings(r.state, ['2324'], { now: t + 2 * 60_000, date: TODAY });
    expect(r.confirmed).toEqual([]);
    r = trackSightings(r.state, ['2324'], { now: t + CONFIRM_MS, date: TODAY });
    expect(r.confirmed).toEqual(['2324']);
  });

  it('start over after a long absence or on a new day', () => {
    const t = at(7, 0);
    let r = trackSightings(null, ['2324'], { now: t, date: TODAY });
    r = trackSightings(r.state, ['2324'], { now: t + LOST_MS + 60_000, date: TODAY });
    expect(r.confirmed).toEqual([]);
    r = trackSightings(
      { date: '2026-10-09', cars: { 2324: { since: t - 86_400_000, last: t - 60_000 } } },
      ['2324'],
      { now: t, date: TODAY },
    );
    expect(r.confirmed).toEqual([]);
    expect(r.state.date).toBe(TODAY);
  });
});

describe('PCC post text', () => {
  const stats = new Map(STATS.vehicleAllTime.map((v) => [v.vehicleId, v]));

  it("counts today in each car's days out", () => {
    // 2324 last seen yesterday: today is its 103rd day. 2337 already counted today.
    expect(statsLine(['2324'], stats, TODAY)).toBe(
      "📊 #2324's 103rd day on the G1 since Feb 9, per the tracker",
    );
    expect(statsLine(['2324', '2337'], stats, TODAY)).toBe(
      '📊 Days on the G1, per the tracker: #2324 103 · #2337 73',
    );
    expect(statsLine(['2399'], stats, TODAY)).toBeNull();
    const debut = new Map([['2328', { daysActive: 1, firstSeen: TODAY, lastSeen: TODAY }]]);
    expect(statsLine(['2328'], debut, TODAY)).toMatch(/never seen #2328 out before/);
  });

  it('announces the first car of the day with a map of the G1', () => {
    const { text, facets, plan, alt } = composePccPost({
      cars: [{ id: '2324', direction: 'Eastbound', destination: 'Richmond-Westmoreland' }],
      newIds: ['2324'],
      first: true,
      buses: 7,
      positions: new Map([['2324', g1('2324')]]),
      stats,
      today: TODAY,
      shapes,
    });
    expect(text).toBe(
      [
        '🚋✨ A vintage PCC trolley is out on the G1 today!',
        '1️⃣ #2324 · Eastbound to Richmond-Westmoreland · next stop Girard Av & 16th St',
        'The other 7 G1 vehicles out are buses.',
        "📊 #2324's 103rd day on the G1 since Feb 9, per the tracker",
        '📍 Live: septa-g-trolley-tracker.netlify.app',
      ].join('\n\n'),
    );
    expect(facets[0].features[0].uri).toBe('https://septa-g-trolley-tracker.netlify.app/');
    expect(plan.title).toBe('G1 · PCC #2324 out now');
    expect(plan.markers).toEqual([{ lat: 39.9719, lon: -75.1635, tag: '1' }]);
    expect(alt).toBe('Map of the G1 along Girard Avenue with PCC trolley #2324 marked.');
  });

  it('lists every car out now in a reply', () => {
    const { text, plan } = composePccPost({
      cars: [
        { id: '2324', direction: 'Eastbound', destination: 'Richmond-Westmoreland' },
        { id: '2337', direction: 'Westbound', destination: '63rd-Girard' },
      ],
      newIds: ['2337'],
      first: false,
      buses: 1,
      positions: new Map(),
      today: TODAY,
      shapes,
    });
    expect(plan).toBeNull();
    expect(text).toBe(
      [
        '🚋 Another PCC is out on the G1: #2337',
        [
          'PCCs out now (2):',
          '#2324 · Eastbound to Richmond-Westmoreland',
          '#2337 · Westbound to 63rd-Girard',
        ].join('\n'),
        'The other G1 vehicle out is a bus.',
        '📍 Live: septa-g-trolley-tracker.netlify.app',
      ].join('\n\n'),
    );
  });

  it('fits a post with many cars', () => {
    const ids = ['2322', '2324', '2326', '2327', '2328', '2332', '2333', '2337'];
    const cars = ids.map((id) => ({
      id,
      direction: 'Westbound',
      destination: '63rd-Girard',
    }));
    const { text } = composePccPost({
      cars,
      newIds: ids,
      first: true,
      buses: 3,
      positions: new Map(ids.map((id) => [id, g1(id)])),
      stats,
      today: TODAY,
      shapes,
    });
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain('8 vintage PCC trolleys');
    expect(text).toContain('septa-g-trolley-tracker.netlify.app');
  });
});

describe('maybePostPcc', () => {
  it('posts the first car of the day, then threads later cars, once each', async () => {
    const { db, poster, client, setNow } = testPoster();
    const tracker = { status: trackerStatus([['2324', 'Eastbound', 'Richmond-Westmoreland']]) };
    const { fetchFn } = fakeTracker(tracker);
    const run = (t, vehicles = [g1('2324'), g1('3676')]) => {
      setNow(t);
      return maybePostPcc({ poster, db, vehicles, shapes, basemap, now: t, fetchFn });
    };

    expect((await run(at(7, 0))).posted).toBe(0); // seen once: not yet
    expect((await run(at(7, 2))).posted).toBe(0);
    const first = await run(at(7, 4));
    expect(first).toMatchObject({ source: 'tracker', cars: 1, posted: 1 });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].account).toBe('metro');
    expect(client.posts[0].opts.text).toMatch(/^🚋✨ A vintage PCC trolley is out/);
    expect(client.posts[0].opts.image).toBeTruthy();
    expect(poster.find('pcc:2026-10-10:2324', 'pcc')).toBeTruthy();

    // Same car, later: nothing new.
    expect((await run(at(7, 30))).posted).toBe(0);

    // A second car comes out.
    tracker.status = trackerStatus([
      ['2324', 'Eastbound', 'Richmond-Westmoreland'],
      ['2337', 'Westbound', '63rd-Girard'],
    ]);
    const vehicles = [g1('2324'), g1('2337', { lat: 39.9727, lon: -75.24 })];
    await run(at(8, 0), vehicles);
    expect((await run(at(8, 4), vehicles)).posted).toBe(1);
    expect(client.posts).toHaveLength(2);
    const reply = client.posts[1];
    expect(reply.opts.text).toMatch(/^🚋 Another PCC is out on the G1: #2337/);
    expect(reply.opts.reply.root.uri).toBe(client.posts[0].uri);
    expect((await run(at(8, 6), vehicles)).posted).toBe(0);
  });

  it("uses SEPTA's positions when the tracker is down, with a link card if no map", async () => {
    const { db, poster, client, setNow } = testPoster();
    const { fetchFn } = fakeTracker({ down: true });
    const vehicles = [g1('2326')];
    for (const t of [at(9, 0), at(9, 4)]) {
      setNow(t);
      await maybePostPcc({ poster, db, vehicles, shapes: null, basemap, now: t, fetchFn });
    }
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].opts.text).toContain('#2326');
    expect(client.posts[0].opts.link.url).toBe('https://septa-g-trolley-tracker.netlify.app/');
  });

  it('stays quiet overnight', async () => {
    const { db, poster } = testPoster();
    const { fetchFn, calls } = fakeTracker({ status: trackerStatus([['2324', '', '']]) });
    const r = await maybePostPcc({
      poster,
      db,
      vehicles: [],
      basemap,
      now: at(2, 0),
      fetchFn,
    });
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
