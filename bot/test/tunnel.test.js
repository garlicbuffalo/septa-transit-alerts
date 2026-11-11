import { describe, expect, it } from 'vitest';
import {
  composeTunnel,
  maybePostTunnel,
  recordTunnel,
  TUNNEL,
  tunnelStatus,
} from '../features/tunnel.js';
import { graphemeLength } from '../lib/text.js';
import { NOW, testPoster } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Two weeks of ordinary readings, a few a day, ending three hours ago. */
function seedHistory(db, { dir = 1, stretch = 1.13, n = 40 } = {}) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO tunnel_samples (ts, dir, stretch) VALUES (?, ?, ?)').run(
      NOW - 3 * HOUR - i * 6 * HOUR,
      dir,
      stretch + (i % 3) * 0.01,
    );
  }
}

describe('the tunnel readings', () => {
  it("keeps a direction's estimate only when it has moved", () => {
    const { db } = testPoster();
    expect(recordTunnel(db, { 0: 1.13, 1: 1.13 }, NOW)).toBe(2);
    expect(recordTunnel(db, { 0: 1.13, 1: 1.2 }, NOW + MIN)).toBe(1);
    expect(recordTunnel(db, null, NOW + 2 * MIN)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tunnel_samples').get().n).toBe(3);
  });

  it('knows the usual once there is enough history, leaving out the last two hours', () => {
    const { db } = testPoster();
    recordTunnel(db, { 1: 1.45 }, NOW - 10 * MIN);
    expect(tunnelStatus(db, 1, NOW).usual).toBeNull();
    seedHistory(db);
    const status = tunnelStatus(db, 1, NOW);
    expect(status.usual).toBeCloseTo(1.14, 2);
    expect(status.latest.stretch).toBe(1.45);
  });
});

describe('a tunnel slowdown', () => {
  it('posts when a direction is well over its usual, then a ✅ once it is back', async () => {
    const { db, poster, client, setNow } = testPoster();
    seedHistory(db);
    // One slow train moves the estimate, but not past the bar.
    expect(
      await maybePostTunnel({ stretch: { 0: 1.13, 1: 1.24 }, db, poster, now: NOW }),
    ).toBeNull();
    setNow(NOW + 10 * MIN);
    const res = await maybePostTunnel({
      stretch: { 0: 1.13, 1: 1.38 },
      db,
      poster,
      now: NOW + 10 * MIN,
    });
    expect(res).toEqual({ posted: 1, cleared: 0 });
    const [post] = client.posts;
    expect(post.account).toBe('metro');
    expect(post.opts.text).toContain(
      'L1 trains are taking about 38% longer than scheduled through the Market St tunnel, westbound toward 69th St (usually about 14%)',
    );
    expect(post.opts.text).toContain('going in at Front St and coming out at 45th St');
    expect(graphemeLength(post.opts.text)).toBeLessThanOrEqual(300);
    // Still slow: nothing more.
    expect(
      await maybePostTunnel({ stretch: { 0: 1.13, 1: 1.41 }, db, poster, now: NOW + 20 * MIN }),
    ).toBeNull();
    setNow(NOW + 50 * MIN);
    const cleared = await maybePostTunnel({
      stretch: { 0: 1.13, 1: 1.16 },
      db,
      poster,
      now: NOW + 50 * MIN,
    });
    expect(cleared).toEqual({ posted: 0, cleared: 1 });
    const reply = client.posts[1];
    expect(reply.opts.text).toBe(
      '✅ L1 trains are back to about 16% over schedule through the tunnel, westbound toward 69th St.',
    );
    expect(reply.opts.reply.root.uri).toBe(post.uri);
  });

  it('needs history, a fresh reading, and room under the cooldown', async () => {
    const { db, poster, client } = testPoster();
    // No history: nothing to judge against.
    expect(await maybePostTunnel({ stretch: { 1: 1.45 }, db, poster, now: NOW })).toBeNull();
    seedHistory(db);
    seedHistory(db, { dir: 0 });
    // The estimate last moved an hour ago (no train has been timed since): old news.
    expect(await maybePostTunnel({ stretch: { 1: 1.45 }, db, poster, now: NOW + HOUR })).toBeNull();
    expect(
      await maybePostTunnel({ stretch: { 1: 1.46 }, db, poster, now: NOW + HOUR + MIN }),
    ).toEqual({
      posted: 1,
      cleared: 0,
    });
    // The other direction slows minutes later: inside the cooldown.
    expect(
      await maybePostTunnel({
        stretch: { 0: 1.44, 1: 1.46 },
        db,
        poster,
        now: NOW + HOUR + 5 * MIN,
      }),
    ).toBeNull();
    expect(client.posts).toHaveLength(1);
  });

  it('is no slowdown under the bar, however calm the tunnel usually is', async () => {
    const { db, poster } = testPoster();
    seedHistory(db, { stretch: 1.02 });
    expect(
      await maybePostTunnel({ stretch: { 1: TUNNEL.minStretch - 0.02 }, db, poster, now: NOW }),
    ).toBeNull();
  });

  it('names each direction by where it goes in and comes out', () => {
    const east = composeTunnel({ dir: 0, stretch: 1.5, usual: 1.1 }).text;
    expect(east).toContain('eastbound toward Frankford');
    expect(east).toContain('going in at 45th St and coming out at Front St');
  });
});
