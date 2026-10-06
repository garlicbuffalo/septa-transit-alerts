import { describe, expect, it } from 'vitest';
import { postAlerts } from '../features/alerts.js';
import {
  composeDetection,
  formatDistance,
  linkDetectionPosts,
  postDetections,
  progressText,
} from '../features/detections.js';
import { callouts, recordEvent, startOfEasternDay } from '../features/history.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import {
  byLabel,
  detectionIncident,
  fakeShapes,
  NOW,
  officialIncident,
  testPoster,
  vehicle,
} from './helpers.js';

const asMap = (...incs) => new Map(incs.map((i) => [i.id, i]));
const basemap = createBasemap();

const gapDetails = {
  direction_id: 0,
  gap_min: 25,
  headway_min: 10,
  cancelled_between: 1,
  vehicles: ['3787', '3314'],
};
const gapVehicles = byLabel([
  vehicle({ label: '3787', lat: 39.97, lateMin: 3, nextStopName: 'Germantown & Lehigh' }),
  vehicle({ label: '3314', lat: 40.03, lateMin: 0, nextStopName: 'Germantown & Chelten' }),
]);

function run(incidents, { poster, db }, over = {}) {
  return postDetections({
    incidents,
    poster,
    db,
    vehicles: gapVehicles,
    shapes: fakeShapes(),
    basemap,
    now: NOW,
    maxAgeMs: 30 * 60_000,
    ...over,
  });
}

describe('detection post text', () => {
  it('describes a gap with its empty stretch, the buses on either side, and a map', () => {
    const inc = detectionIncident({ details: gapDetails });
    const { text, plan, alt } = composeDetection({
      incident: inc,
      det: inc.detections[0],
      vehicles: gapVehicles,
      shapes: fakeShapes(),
      calloutLine: '📊 2nd Route 23 gap reported today',
    });
    expect(text.split('\n\n')).toEqual([
      '🕳️ Route 23 — toward 11th-Market',
      '~25 min between buses — scheduled every ~10 min. Nothing between Germantown & Chelten and Germantown & Lehigh.',
      '1 cancelled trip in between.',
      'Last seen: #3787 (3 min late) · Next up: #3314 (on time)',
      '📊 2nd Route 23 gap reported today',
      '🔗 septa-transit-alerts.example',
    ]);
    expect(plan.markers.map((m) => m.tag)).toEqual(['L', 'N']);
    expect(plan.stretch.points.length).toBeGreaterThanOrEqual(2);
    expect(alt).toMatch(/dashed/);
  });

  it('numbers bunched vehicles from the lead one and measures their spread', () => {
    const vehicles = byLabel([
      vehicle({ label: 'a', nextStopSequence: 20, lat: 40.0, lateMin: 5 }),
      vehicle({ label: 'b', nextStopSequence: 22, lat: 40.001 }),
      vehicle({ label: 'c', nextStopSequence: 21, lat: 40.0005, lateMin: -3 }),
    ]);
    const inc = detectionIncident({
      source: 'bunching',
      details: {
        direction_id: 0,
        vehicle_count: 3,
        distance_m: 50,
        scheduled_spacing_min: 24,
        vehicles: ['a', 'b', 'c'],
      },
    });
    const { text, plan } = composeDetection({
      incident: inc,
      det: inc.detections[0],
      vehicles,
      shapes: fakeShapes(),
    });
    expect(text).toContain('3 buses within 370 ft, scheduled ~24 min apart');
    expect(text).toContain('Buses: #b (1️⃣, on time), #c (2️⃣, 3 min early), #a (3️⃣, 5 min late)');
    expect(plan.markers.map((m) => m.tag)).toEqual(['1', '2', '3']);
  });

  it('describes stuck vehicles and silent routes', () => {
    const held = detectionIncident({
      source: 'pulse-held',
      route: '33',
      details: { vehicle_count: 2, stationaryMs: 14 * 60_000, vehicles: [] },
      fromStation: null,
      directionLabel: null,
    });
    expect(
      composeDetection({
        incident: held,
        det: held.detections[0],
        vehicles: new Map(),
        shapes: null,
      }).text,
    ).toMatch(/^🚌🚨 Route 33: buses stuck\n\n🛑 2 buses stopped 14\+ min\./);
    const thin = detectionIncident({
      source: 'thin-gap',
      route: '35',
      details: { silent_min: 70, headway_min: 30, missed_trips: 2 },
    });
    const { text, plan } = composeDetection({
      incident: thin,
      det: thin.detections[0],
      vehicles: new Map(),
      shapes: null,
    });
    expect(text.split('\n\n').slice(0, 2)).toEqual([
      '🕳️ Route 35: no buses on the tracker for ~70 min',
      'Scheduled every ~30 min, so ~2 trips have gone by unseen.',
    ]);
    expect(plan).toBeNull();
  });

  it('fits long texts in a post and formats distances', () => {
    const inc = detectionIncident({ details: { ...gapDetails } });
    const vehicles = byLabel([
      vehicle({ label: '3787', nextStopName: 'X'.repeat(150) }),
      vehicle({ label: '3314', nextStopName: 'Y'.repeat(150) }),
    ]);
    const { text } = composeDetection({
      incident: inc,
      det: inc.detections[0],
      vehicles,
      shapes: null,
    });
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(formatDistance(100)).toBe('330 ft');
    expect(formatDistance(800)).toBe('0.50 mi');
  });

  it('writes hourly progress lines', () => {
    const thin = detectionIncident({
      source: 'thin-gap',
      route: '35',
      onsetTs: NOW - 2 * 3_600_000,
      details: { headway_min: 30 },
    });
    expect(progressText(thin, thin.detections[0], NOW)).toBe(
      '🚌 Route 35 · still no buses on the tracker — ~2h in, ~4 scheduled trips missed so far.',
    );
  });
});

describe('postDetections', () => {
  it('posts a new gap once, with a map, on the bus account', async () => {
    const t = testPoster();
    const incidents = asMap(detectionIncident({ details: gapDetails }));
    expect((await run(incidents, t)).posted).toBe(1);
    expect(t.client.posts[0].account).toBe('bus');
    expect(t.client.posts[0].opts.image.alt).toMatch(/Route 23/);
    expect((await run(incidents, t)).posted).toBe(0);
    expect(t.client.posts).toHaveLength(1);
  });

  it('posts SEPTA Metro detections on the metro account', async () => {
    const t = testPoster();
    const inc = detectionIncident({
      id: 'gap-t1',
      mode: 'metro',
      route: 't1',
      details: gapDetails,
    });
    await run(asMap(inc), t);
    expect(t.client.posts[0].account).toBe('metro');
    expect(t.client.posts[0].opts.text).toMatch(/^🕳️ T1 — toward/);
  });

  it('skips backlog and resolved detections', async () => {
    const t = testPoster(undefined, { since: NOW - 10 * 60_000 });
    const incidents = asMap(
      detectionIncident({ id: 'old', firstSeen: NOW - 20 * 60_000, details: gapDetails }),
      detectionIncident({ id: 'done', resolvedTs: NOW - 1000, details: gapDetails }),
    );
    expect((await run(incidents, t)).skipped).toBe(2);
    expect(t.poster.skipped('det:old')).toBe('before-posting-started');
    expect(t.poster.skipped('det:done')).toBe('resolved-before-post');
  });

  it('holds a route to an hour between posts and a daily cap, unless it gets much worse', async () => {
    const t = testPoster();
    const gap = (id, gapMin, firstSeen = NOW - 60_000) =>
      detectionIncident({ id, firstSeen, details: { ...gapDetails, gap_min: gapMin } });
    await run(asMap(gap('g1', 25)), t);
    // Same route, similar gap, inside the hour: cooldown.
    await run(asMap(gap('g2', 26)), t, { now: NOW + 10 * 60_000 });
    expect(t.poster.skipped('det:g2')).toBe('cooldown');
    // Much worse (ratio 4.0 vs 2.5): posts anyway, with a callout.
    await run(asMap(gap('g3', 40, NOW + 19 * 60_000)), t, { now: NOW + 20 * 60_000 });
    expect(t.client.posts).toHaveLength(2);
    expect(t.client.posts[1].opts.text).toContain('📊 2nd Route 23 gap reported today');
  });

  it('quotes the post into the alerts thread when attached to a SEPTA alert', async () => {
    const t = testPoster();
    const official = officialIncident({ id: 'alert-7', mode: 'bus', routes: ['23'] });
    await postAlerts({
      incidents: asMap(official),
      poster: t.poster,
      now: NOW,
      maxAgeMs: 1_800_000,
    });
    const inc = detectionIncident({ id: 'alert-7-gap-1000', official, details: gapDetails });
    const stats = await run(asMap(inc), t);
    expect(stats).toMatchObject({ posted: 1, quoted: 1 });
    const quote = t.client.posts.at(-1);
    expect(quote.account).toBe('alerts');
    expect(quote.opts.quote.uri).toBe(t.client.posts[1].uri);
    expect(quote.opts.reply.root.uri).toBe(t.client.posts[0].uri);
  });

  it('follows a silent route with hourly replies and a ✅ when it ends', async () => {
    const t = testPoster();
    const details = { silent_min: 70, headway_min: 30, missed_trips: 2 };
    const open = detectionIncident({
      id: 'thin',
      source: 'thin-gap',
      route: '35',
      onsetTs: NOW - 70 * 60_000,
      details,
    });
    await run(asMap(open), t);
    await run(asMap(open), t, { now: NOW + 30 * 60_000 });
    expect(t.client.posts).toHaveLength(1);
    t.setNow(NOW + 60 * 60_000);
    await run(asMap(open), t, { now: NOW + 60 * 60_000 });
    expect(t.client.posts[1].opts.text).toMatch(/still no buses on the tracker/);
    const closed = detectionIncident({
      id: 'thin',
      source: 'thin-gap',
      route: '35',
      resolvedTs: NOW + 65 * 60_000,
      details,
      resolvedDescription: 'Route 35 buses back on the tracker.',
    });
    await run(asMap(closed), t, { now: NOW + 70 * 60_000 });
    expect(t.client.posts[2].opts.text).toBe('✅ Route 35 buses back on the tracker.');
    expect(t.client.posts[2].opts.reply.root.uri).toBe(t.client.posts[0].uri);
  });

  it('links posts and ✅ replies into the published detections', async () => {
    const t = testPoster();
    const incidents = asMap(detectionIncident({ details: gapDetails }));
    await run(incidents, t);
    expect(linkDetectionPosts(incidents, t.poster)).toBe(1);
    const det = incidents.get('gap-2026-10-06-23-0-1000').detections[0];
    expect(det.post_url).toBe('https://bsky.app/profile/did:plc:bus/post/p1');
    expect(det.resolved_post_url).toBeNull();
    expect(linkDetectionPosts(incidents, t.poster)).toBe(0);
  });
});

describe('history', () => {
  it('counts today in Philadelphia time and flags records after enough history', () => {
    const { db } = testPoster();
    const day = startOfEasternDay(NOW);
    for (const [i, ratio] of [2.1, 2.4, 2.2].entries()) {
      recordEvent(db, {
        subject: `old${i}`,
        source: 'gap',
        mode: 'bus',
        route: '23',
        metric: 20,
        ratio,
        ts: day - (i + 1) * 86_400_000,
        posted: 1,
      });
    }
    recordEvent(db, {
      subject: 'today',
      source: 'gap',
      mode: 'bus',
      route: '23',
      metric: 30,
      ratio: 3,
      ts: day + 1000,
      posted: 1,
    });
    expect(
      callouts(db, {
        source: 'gap',
        route: '23',
        label: 'Route 23',
        ts: NOW,
        score: 3.5,
        scoreOf: (r) => r.ratio,
      }),
    ).toEqual([
      '2nd Route 23 gap reported today',
      'biggest gap vs schedule on this route in 30 days',
    ]);
  });
});
