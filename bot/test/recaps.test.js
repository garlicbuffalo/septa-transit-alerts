import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { postDetections } from '../features/detections.js';
import { recordEvent } from '../features/history.js';
import {
  bunchingHotspots,
  composeGaps,
  composeHotspots,
  gapsByRoute,
  postRecap,
} from '../features/recaps.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { bubbleRadius, renderHotspotMap } from '../map/hotspotMap.js';
import { byLabel, detectionIncident, fakeShapes, NOW, testPoster, vehicle } from './helpers.js';

// Sunday, Oct 11, 2026, 10:20 AM in Philadelphia: the weekly recap covers Oct 4–10.
const SUNDAY = Date.UTC(2026, 9, 11, 14, 20);

let seq = 0;
function event(db, over) {
  recordEvent(db, {
    subject: `det:e${seq++}`,
    source: 'bunching',
    mode: 'bus',
    route: '23',
    near: 'Broad & Walnut',
    lat: 39.9489,
    lon: -75.1638,
    ts: Date.UTC(2026, 9, 7, 16),
    ...over,
  });
}

describe('detection history for recaps', () => {
  it('records every detection seen, including ones held back by the posting budget', async () => {
    const t = testPoster();
    const incidents = new Map(
      ['a', 'b', 'c'].map((id, i) => {
        const inc = detectionIncident({
          id: `gap-${id}`,
          route: String(20 + i),
          details: { gap_min: 30 + i, headway_min: 10, vehicles: [`${id}1`, `${id}2`] },
        });
        return [inc.id, inc];
      }),
    );
    const vehicles = byLabel(
      ['a', 'b', 'c'].flatMap((id) => [
        vehicle({ label: `${id}1`, nextStopName: `${id} St - FS` }),
        vehicle({ label: `${id}2`, lat: 40.02 }),
      ]),
    );
    const stats = await postDetections({
      incidents,
      poster: t.poster,
      db: t.db,
      vehicles,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      now: NOW,
      maxAgeMs: 30 * 60_000,
    });
    // One gap posts this tick; the other two wait.
    expect(stats.posted).toBe(1);
    const rows = t.db
      .prepare('SELECT subject, posted, near FROM detection_events ORDER BY subject')
      .all();
    expect(rows).toEqual([
      { subject: 'det:gap-a', posted: 0, near: 'a St' },
      { subject: 'det:gap-b', posted: 0, near: 'b St' },
      { subject: 'det:gap-c', posted: 1, near: 'c St' },
    ]);
  });
});

describe('bunching hotspots', () => {
  it('groups by stop, else by position, keeping places with 3+ bunches', () => {
    const events = [
      ...Array.from({ length: 4 }, (_, i) => ({
        near: 'Broad & Walnut',
        route: i < 3 ? '4' : '16',
        lat: 39.9489,
        lon: -75.1638,
      })),
      ...Array.from({ length: 3 }, () => ({ near: null, route: '33', lat: 39.98012, lon: -75.15 })),
      { near: 'Elsewhere', route: '9', lat: 40, lon: -75.2 },
    ];
    const spots = bunchingHotspots(events);
    expect(spots.map((s) => [s.name, s.count, s.routes])).toEqual([
      ['Broad & Walnut', 4, ['4', '16']],
      [null, 3, ['33']],
    ]);
    const { text, alt } = composeHotspots('bus', spots, 8, 'Oct 4 – Oct 10');
    expect(text.split('\n\n')).toEqual([
      '🚌 Chronic bus bunching spots · Oct 4 – Oct 10',
      '8 bunches seen; the places it happened most:\n· Broad & Walnut — Routes 4, 16 (4)\n· Unnamed stop — Route 33 (3)',
      'Only what the bot saw; real totals may be higher.',
    ]);
    expect(alt).toContain('Broad & Walnut (4)');
  });

  it('lists only as many places as fit in a post', () => {
    const spots = Array.from({ length: 10 }, (_, i) => ({
      name: `A Very Long Stop Name Number ${i} & Another Street`,
      count: 10 - i,
      routes: ['4', '16', '27'],
    }));
    const { text } = composeHotspots('bus', spots, 55, 'September 2026');
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain('Number 0');
  });

  it('sizes bubbles by the log of the count', () => {
    expect(bubbleRadius(1)).toBe(26);
    expect(bubbleRadius(3)).toBe(40);
    expect(bubbleRadius(15)).toBe(68);
  });
});

describe('gap recaps', () => {
  it('counts gaps by route and charts the top routes from zero', () => {
    const byRoute = gapsByRoute([
      { route: '79' },
      { route: '79' },
      { route: '52' },
      ...Array.from({ length: 12 }, () => ({ route: '7' })),
    ]);
    expect(byRoute).toEqual([
      { route: '7', count: 12 },
      { route: '79', count: 2 },
      { route: '52', count: 1 },
    ]);
    const { text, chart } = composeGaps('bus', byRoute, 15, 'Oct 4 – Oct 10');
    expect(text.split('\n\n')[1]).toBe(
      '15 gaps of more than twice the scheduled spacing, across 3 routes. Most often:\n· Route 7 (12)\n· Route 79 (2)\n· Route 52 (1)',
    );
    expect(chart.ticks).toEqual([0, 5, 10, 15]);
    expect(chart.max).toBe(15);
  });
});

describe('weekly recap posts', () => {
  it('posts the hotspot map, then the gap chart as a reply, once', async () => {
    const t = testPoster();
    for (let i = 0; i < 5; i++) event(t.db, { ts: Date.UTC(2026, 9, 5 + i, 16) });
    for (let i = 0; i < 3; i++)
      event(t.db, { near: 'Market & 52nd', lat: 39.96, lon: -75.225, route: '52' });
    for (let i = 0; i < 6; i++) event(t.db, { source: 'gap', route: i < 4 ? '79' : '7' });
    // Outside the week, and on the other account.
    event(t.db, { ts: Date.UTC(2026, 9, 2, 16) });
    event(t.db, { mode: 'metro', route: 't1' });
    const args = {
      db: t.db,
      poster: t.poster,
      basemap: createBasemap(),
      account: 'bus',
      period: 'week',
      now: SUNDAY,
    };
    expect(await postRecap(args)).toEqual({ posted: 'week', hotspots: 2, gaps: 6 });
    const [map, gaps] = t.client.posts;
    expect(map.opts.text).toMatch(
      /^🚌 Chronic bus bunching spots · Oct 4 – Oct 10\n\n8 bunches seen/,
    );
    expect(await sharp(map.opts.image.data).metadata()).toMatchObject({
      width: 1200,
      height: 1200,
    });
    expect(gaps.opts.reply.parent.uri).toBe(map.uri);
    expect(gaps.opts.text).toMatch(/^⏰ Long gaps between buses · Oct 4 – Oct 10/);
    expect(await postRecap(args)).toEqual({ skipped: 'posted' });
    // Quiet week on the metro account: one bunch isn't a hotspot.
    expect(await postRecap({ ...args, account: 'metro' })).toEqual({ skipped: 'quiet' });
  });

  it('renders a hotspot map', async () => {
    const jpg = await renderHotspotMap({
      spots: [
        { lat: 39.95, lon: -75.16, count: 9 },
        { lat: 39.97, lon: -75.2, count: 3 },
      ],
      title: 'Bunching hotspots',
      basemap: createBasemap(),
    });
    expect((await sharp(jpg).metadata()).format).toBe('jpeg');
  });
});
