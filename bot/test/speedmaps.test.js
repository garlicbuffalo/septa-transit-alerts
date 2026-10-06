import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  composeSpeedMap,
  computeSpeeds,
  postSpeedMap,
  SPEED_CONFIG,
  speedCallout,
  speedCandidates,
} from '../features/speedmaps.js';
import { locateAlong, measureShape, sliceAlong } from '../lib/geo.js';
import { recordObservations } from '../lib/observations.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { bandFor, renderSpeedMap, SPEED_BANDS } from '../map/speedMap.js';
import { fakeShapes, NOW, testPoster, vehicle } from './helpers.js';

const MIN = 60_000;
// 10 mph is 268 m a minute, 0.00241° of latitude.
const DEG_PER_MIN_AT_10MPH = 268.2 / 111_320;
const SHAPE = [
  [40.05, -75.17],
  [39.95, -75.17],
];

/** A vehicle heading south at `mph` for `minutes`, one report a minute. */
function trip(id, { from, mph, minutes, start = NOW - 30 * MIN, route = '23' }) {
  return Array.from({ length: minutes + 1 }, (_, m) => ({
    vehicle_id: id,
    route,
    t: start + m * MIN,
    lat: from - (m * DEG_PER_MIN_AT_10MPH * mph) / 10,
    lon: -75.17,
  }));
}

function record(db, samples, { mode = 'bus', direction = 'Southbound' } = {}) {
  for (const s of samples) {
    recordObservations(db, s.t, {
      vehicles: [
        vehicle({
          id: s.vehicle_id,
          label: s.vehicle_id,
          mode,
          route: s.route,
          lat: s.lat,
          lon: s.lon,
          directionName: direction,
          reportTs: s.t,
        }),
      ],
    });
  }
}

describe('shapes measured in meters', () => {
  const m = measureShape(SHAPE);

  it('locates a position along the shape and how far off it', () => {
    expect(m.length).toBeCloseTo(11_132, -1);
    const loc = locateAlong(m, { lat: 40.0, lon: -75.169 });
    expect(loc.along).toBeCloseTo(5566, -1);
    expect(loc.off).toBeCloseTo(85, -1);
  });

  it('slices the shape between two distances', () => {
    const part = sliceAlong(m, 1000, 2000);
    expect(part).toHaveLength(2);
    expect(part[0][0]).toBeCloseTo(40.05 - 1000 / 111_320, 5);
    expect(part[1][0]).toBeCloseTo(40.05 - 2000 / 111_320, 5);
  });
});

describe('speeds along a route', () => {
  const m = measureShape(SHAPE);

  it('bins each stretch by total distance over total time', () => {
    const samples = [
      ...trip('a', { from: 40.045, mph: 10, minutes: 20 }),
      ...trip('b', { from: 39.995, mph: 3, minutes: 20 }),
    ];
    const r = computeSpeeds(samples, m, SPEED_CONFIG.bus);
    expect(r.bins).toHaveLength(40);
    const known = r.bins.filter(Boolean);
    expect(known.length).toBeGreaterThan(20);
    // The first half is a's (10 mph), the stretch after it b's (3 mph).
    expect(r.bins[5].mph).toBeCloseTo(10, 0);
    expect(r.bins[24].mph).toBeCloseTo(3, 0);
    expect(r.avgMph).toBeCloseTo(6.5, 0);
    expect(r.coverage).toBeGreaterThan(0.5);
  });

  it('skips impossible speeds, long gaps between reports, and layovers at the ends', () => {
    const jump = [
      { vehicle_id: 'x', t: NOW, lat: 40.0, lon: -75.17 },
      { vehicle_id: 'x', t: NOW + MIN, lat: 39.97, lon: -75.17 }, // 200 mph
      { vehicle_id: 'x', t: NOW + 10 * MIN, lat: 39.969, lon: -75.17 }, // 9 min later
    ];
    expect(computeSpeeds(jump, m, SPEED_CONFIG.bus).pairs).toBe(0);
    const parked = trip('p', { from: 40.0495, mph: 0, minutes: 10 });
    expect(computeSpeeds(parked, m, SPEED_CONFIG.bus).pairs).toBe(0);
  });

  it('uses half-mile stretches and train speeds for Regional Rail', () => {
    const samples = trip('t', { from: 40.04, mph: 40, minutes: 10 });
    const r = computeSpeeds(samples, m, SPEED_CONFIG.rail);
    expect(r.binM).toBe(805);
    expect(r.bins).toHaveLength(14);
    expect(r.avgMph).toBeCloseTo(40, 0);
    expect(bandFor(SPEED_BANDS.rail, r.avgMph).emoji).toBe('🟪');
  });
});

describe('speed map posts', () => {
  it('takes routes in turn, least recently mapped first', () => {
    const { db } = testPoster();
    record(db, [
      ...['a', 'b', 'c'].flatMap((id) => trip(id, { from: 40.04, mph: 8, minutes: 3 })),
      ...['d', 'e', 'f', 'g'].flatMap((id) =>
        trip(id, { from: 40.04, mph: 8, minutes: 3, route: '47' }),
      ),
      ...['h', 'i'].flatMap((id) => trip(id, { from: 40.04, mph: 8, minutes: 3, route: '9' })),
    ]);
    const since = NOW - HOUR();
    expect(speedCandidates(db, 'bus', { since }).map((r) => r.route)).toEqual(['47', '23']);
    db.prepare(
      "INSERT INTO speedmap_runs (account, route, ts, avg_mph) VALUES ('bus', '47', ?, 9)",
    ).run(NOW - MIN);
    expect(speedCandidates(db, 'bus', { since }).map((r) => r.route)).toEqual(['23', '47']);
  });

  it('calls out the slowest or fastest map of a route in 14 days', () => {
    const { db } = testPoster();
    const put = (mph, ago) =>
      db
        .prepare(
          "INSERT INTO speedmap_runs (account, route, ts, avg_mph) VALUES ('bus', '23', ?, ?)",
        )
        .run(NOW - ago, mph);
    put(9, MIN);
    put(10, 2 * MIN);
    expect(speedCallout(db, { account: 'bus', route: '23', avgMph: 5, now: NOW })).toBeNull();
    put(11, 15 * 24 * 60 * MIN); // too old to count
    put(12, 3 * MIN);
    expect(speedCallout(db, { account: 'bus', route: '23', avgMph: 5, now: NOW })).toBe(
      '📊 slowest reported in 14 days',
    );
    expect(speedCallout(db, { account: 'bus', route: '23', avgMph: 13, now: NOW })).toBe(
      '📊 fastest reported in 14 days',
    );
    expect(speedCallout(db, { account: 'bus', route: '23', avgMph: 10, now: NOW })).toBeNull();
  });

  it('writes the text with a color key, under 300 characters', () => {
    const result = { avgMph: 8.44, bins: [{ mph: 4 }, { mph: 12 }, null] };
    const { text, alt, facets } = composeSpeedMap({
      mode: 'bus',
      route: '23',
      direction: 'Southbound',
      start: Date.UTC(2026, 9, 6, 19),
      end: Date.UTC(2026, 9, 6, 20),
      result,
      bands: SPEED_BANDS.road,
      callout: '📊 slowest reported in 14 days',
    });
    expect(text.split('\n\n')[0]).toBe(
      '🚦 Route 23 — Southbound\n3:00–4:00 PM · average speed 8.4 mph\n📊 slowest reported in 14 days',
    );
    expect(text).toContain('🟥 under 5 mph · 🟧 5–10 · 🟨 10–15 · 🟩 15+ mph');
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets[0].features[0].uri).toMatch(/\/route\/23$/);
    expect(alt).toContain('with 1 of 3 stretches under 5 mph');
  });

  it('maps the busiest direction of the least recently mapped route and records it', async () => {
    const t = testPoster();
    record(t.db, [
      ...trip('a', { from: 40.045, mph: 10, minutes: 25 }),
      ...trip('b', { from: 40.0, mph: 4, minutes: 25 }),
      ...trip('c', { from: 40.02, mph: 7, minutes: 25 }),
    ]);
    // A northbound bus, fewer reports: not the direction mapped.
    record(t.db, trip('n', { from: 39.96, mph: -8, minutes: 5 }), { direction: 'Northbound' });
    const args = {
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      account: 'bus',
      now: NOW,
    };
    const r = await postSpeedMap(args);
    expect(r).toMatchObject({ posted: '23' });
    const post = t.client.posts[0];
    expect(post.account).toBe('bus');
    expect(post.opts.text).toMatch(/^🚦 Route 23 — Southbound\n/);
    expect(await sharp(post.opts.image.data).metadata()).toMatchObject({
      width: 1200,
      height: 1200,
    });
    expect(t.db.prepare('SELECT route, direction FROM speedmap_runs').all()).toEqual([
      { route: '23', direction: 'Southbound' },
    ]);
    // Nothing else qualifies, and too little data for the rail account.
    expect(await postSpeedMap({ ...args, account: 'rail' })).toEqual({
      skipped: 'no-route',
      candidates: 0,
    });
  });

  it('renders stretches in their band colors', async () => {
    const m = measureShape(SHAPE);
    const jpg = await renderSpeedMap({
      measured: m,
      bins: [{ mph: 3 }, null, { mph: 20 }],
      binM: m.length / 3,
      bands: SPEED_BANDS.road,
      title: 'Route 23 · speeds',
      basemap: createBasemap(),
    });
    expect((await sharp(jpg).metadata()).format).toBe('jpeg');
  });
});

function HOUR() {
  return 60 * MIN;
}
