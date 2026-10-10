// The Market-Frankford Line's trains in the bot: from the collector's tracker
// (collector/lib/subwayTrains.js) onto the detection maps, the timelapses, and the
// observations, but not the speed maps or cross-route clusters.
import { describe, expect, it } from 'vitest';
import { findCluster } from '../features/crossBunching.js';
import { composeDetection } from '../features/detections.js';
import { speedCandidates } from '../features/speedmaps.js';
import {
  captureSamples,
  sampleCaptures,
  snapshotText,
  startCapture,
  startDetectionCapture,
  startSnapshots,
} from '../features/timelapse.js';
import { recordObservations } from '../lib/observations.js';
import { buildTracks, positionAt } from '../video/tracks.js';
import { byLabel, detectionIncident, fakeShapes, NOW, testPoster, vehicle } from './helpers.js';

const MIN = 60_000;

// An L1 train as the tracker gives it: GPS, or placed by the schedule in the tunnel.
const train = (car, over = {}) =>
  vehicle({
    id: `L1-${car}`,
    label: car,
    mode: 'metro',
    route: 'l1',
    tripId: `w-${car}`,
    directionName: 'Westbound',
    destination: '69th St Transit Center',
    lat: 39.9525,
    lon: -75.17,
    nextStopSequence: 15,
    nextStopName: '13th St',
    estimated: false,
    cars: [car],
    ...over,
  });

describe('L1 trains placed by the schedule', () => {
  it('are kept as such in the timelapse tracks', () => {
    const tracks = buildTracks([
      { vehicle_id: 'L1-1011', route: 'l1', t: NOW, lat: 39.953, lon: -75.142, estimated: 0 },
      { vehicle_id: 'L1-1011', route: 'l1', t: NOW + MIN, lat: 39.952, lon: -75.15, estimated: 1 },
    ]);
    const track = tracks.get('L1-1011');
    expect(track.points.map((p) => p.est)).toEqual([false, true]);
    expect(positionAt(track, NOW + 10_000).est).toBe(false);
    expect(positionAt(track, NOW + 50_000).est).toBe(true);
    expect(positionAt(track, NOW + 2 * MIN).est).toBe(true);
  });

  it('are named and drawn dashed in a detection post', () => {
    const inc = detectionIncident({
      source: 'bunching',
      mode: 'metro',
      route: 'l1',
      directionLabel: 'toward 69th St Transit Center',
      details: {
        direction_id: 1,
        vehicle_count: 2,
        distance_m: 120,
        scheduled_spacing_min: 10,
        vehicles: ['1011', '1200'],
      },
    });
    const vehicles = byLabel([
      train('1011', { estimated: true, lateMin: 4, nextStopSequence: 16 }),
      train('1200', { lat: 39.9526, lateMin: 0 }),
    ]);
    const shapes = fakeShapes({
      l1: [
        [39.9525, -75.1],
        [39.9525, -75.25],
      ],
    });
    const { text, plan, alt } = composeDetection({
      incident: inc,
      det: inc.detections[0],
      vehicles,
      shapes,
    });
    expect(text).toMatch(/#1011 \(1️⃣, 4 min late, in the tunnel\), #1200 \(2️⃣, on time\)/);
    expect(plan.markers.map((m) => [m.tag, m.estimated])).toEqual([
      ['1', true],
      ['2', false],
    ]);
    expect(alt).toMatch(/Dashed markers are trains in the tunnel/);
  });

  it('follow an L1 timelapse from the vehicle feed, not TransitView', async () => {
    const { db } = testPoster();
    const id = startDetectionCapture(db, {
      kind: 'bunching',
      subject: 'det:l1',
      account: 'metro',
      mode: 'metro',
      routes: ['l1'],
      title: 'L1',
      header: 'L1',
      noun: 'trains',
      vehicles: [
        { id: 'L1-1011', label: '1011', tag: '1' },
        { id: 'L1-1200', label: '1200', tag: '2' },
      ],
      post: { uri: 'at://x' },
      now: NOW,
    });
    expect(id).not.toBeNull();
    const calls = [];
    const sources = {
      async transitViewRoute(route) {
        calls.push(route);
        return { bus: [] };
      },
    };
    let polls = 0;
    const subway = async () => {
      polls++;
      return [
        train('1011', { estimated: true, reportTs: NOW + 1000 }),
        train('1200', { reportTs: NOW - 4000 }),
        // Overdue out of the tunnel: where it is isn't known.
        train('1149', { estimated: true, frozen: true, reportTs: NOW + 1000 }),
      ];
    };
    expect(await sampleCaptures({ db, sources, subway, now: NOW + 1000 })).toEqual({
      captures: 1,
      samples: 2,
    });
    expect(calls).toEqual([]); // TransitView only has placeholders for the L1
    expect(polls).toBe(1);
    const rows = db
      .prepare('SELECT vehicle_id, estimated FROM capture_samples ORDER BY vehicle_id')
      .all();
    expect(rows).toEqual([
      { vehicle_id: 'L1-1011', estimated: 1 },
      { vehicle_id: 'L1-1200', estimated: 0 },
    ]);
  });

  it('join the Metro snapshot, and only it', async () => {
    const { db } = testPoster();
    startSnapshots(db, { now: NOW });
    let polls = 0;
    const sources = {
      async transitView() {
        return { routes: [{}] };
      },
    };
    const subway = async () => {
      polls++;
      return [train('1011', { reportTs: NOW })];
    };
    await sampleCaptures({ db, sources, subway, now: NOW + 1000 });
    expect(polls).toBe(1);
    const rows = db
      .prepare(
        'SELECT c.mode, s.route FROM capture_samples s JOIN captures c ON c.id = s.capture_id',
      )
      .all();
    expect(rows).toEqual([{ mode: 'metro', route: 'l1' }]);
    const { text, alt } = snapshotText({
      mode: 'metro',
      tracks: buildTracks([
        { vehicle_id: 'L1-1011', route: 'l1', t: NOW, lat: 39.95, lon: -75.15 },
        { vehicle_id: 'L1-1011', route: 'l1', t: NOW + 15 * MIN, lat: 39.95, lon: -75.2 },
      ]),
      start: NOW,
      end: NOW + 15 * MIN,
    });
    expect(text).toMatch(/^🚋 SEPTA Metro trolleys, M1 and L1/);
    expect(text).toMatch(/L1 1/);
    expect(alt).toMatch(/placed by the schedule/);
  });

  it('are recorded in the observations as placed, and filled into a capture so', () => {
    const { db } = testPoster();
    recordObservations(db, NOW, {
      vehicles: [train('1011', { estimated: true }), train('1200')],
    });
    const capture = {
      id: startCapture(db, {
        kind: 'bunching',
        subject: 's',
        account: 'metro',
        mode: 'metro',
        routes: ['l1'],
        start: NOW,
        durationMs: 10 * MIN,
      }),
      routes: JSON.stringify(['l1']),
      mode: 'metro',
      start_ts: NOW,
      end_ts: NOW + 10 * MIN,
    };
    const samples = captureSamples(db, capture).map((s) => [s.vehicle_id, s.estimated]);
    expect(samples.sort()).toEqual([
      ['L1-1011', 1],
      ['L1-1200', 0],
    ]);
  });
});

describe('L1 trains elsewhere in the bot', () => {
  it('never join a cross-route cluster: the El and the subway share no street', () => {
    const at = (i, over) =>
      vehicle({ id: `v${i}`, label: `v${i}`, lat: 39.95 + i * 0.0002, ...over });
    const vs = [at(0, { route: '17' }), at(1, { route: '33' }), at(2, { route: '48' })];
    const stopped = new Set(['v0', 'v1', 'v2', 'L1-1011']);
    const withTrain = [...vs, train('1011', { lat: 39.9503, lon: -75.17 })];
    expect(findCluster({ vehicles: withTrain, stopped, schedule: null, now: NOW })).toBeNull();
    const withBus = [...vs, at(3, { route: '2' })];
    expect(
      findCluster({
        vehicles: withBus,
        stopped: new Set(['v0', 'v1', 'v2']),
        schedule: null,
        now: NOW,
      }),
    ).toHaveLength(4);
  });

  it('are left out of the speed maps, a third of their line being the tunnel', () => {
    const { db } = testPoster();
    for (let m = 0; m <= 5; m++) {
      recordObservations(db, NOW - m * MIN, {
        vehicles: ['1011', '1200', '1020'].map((car, i) =>
          train(car, { lat: 39.96 + m * 0.001 + i * 0.01, reportTs: NOW - m * MIN }),
        ),
      });
    }
    expect(speedCandidates(db, 'metro', { since: NOW - 60 * MIN })).toEqual([]);
  });
});
