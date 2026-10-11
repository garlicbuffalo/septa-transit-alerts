import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, composePccPost, maybePostPcc } from '../features/pcc.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { fakeShapes, testPoster } from './helpers.js';

// Saturday, Oct 10, 2026, in Philadelphia (UTC−4).
const at = (h, m) => Date.UTC(2026, 9, 10, h + 4, m);
const basemap = createBasemap();
const shapes = fakeShapes({
  g1: [
    [39.9727, -75.2463],
    [39.9711, -75.1577],
    [39.9842, -75.0998],
  ],
});

/** A car in pcc.json's shape. */
const car = (id, over = {}) => ({
  id,
  direction: 'Eastbound',
  destination: 'Richmond-Westmoreland',
  next_stop: 'Girard Av & 16th St',
  lat: 39.9719,
  lon: -75.1635,
  late_min: 0,
  first_seen_ts: at(7, 0),
  ...over,
});

describe('PCC post text', () => {
  it('announces the first car of the day with a map of the G1', () => {
    const { text, facets, plan, alt } = composePccPost({
      cars: [car('2324')],
      newIds: ['2324'],
      first: true,
      buses: 7,
      shapes,
    });
    expect(text).toBe(
      [
        '🚋✨ A vintage PCC trolley is out on the G1 today!',
        '1️⃣ #2324 · Eastbound to Richmond-Westmoreland · next stop Girard Av & 16th St',
        'The other 7 G1 vehicles out are buses.',
        '📍 Follow it live: septa-g-trolley-tracker.netlify.app',
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
        car('2324', { next_stop: null }),
        car('2337', { direction: 'Westbound', destination: '63rd-Girard', next_stop: null }),
      ],
      newIds: ['2337'],
      first: false,
      buses: 1,
      shapes: null,
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
        '📍 Follow them live: septa-g-trolley-tracker.netlify.app',
      ].join('\n\n'),
    );
  });

  it('fits a post with many cars', () => {
    const ids = ['2322', '2324', '2326', '2327', '2328', '2332', '2333', '2337'];
    const { text } = composePccPost({
      cars: ids.map((id) => car(id)),
      newIds: ids,
      first: true,
      buses: 3,
      shapes,
    });
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain('8 vintage PCC trolleys');
    expect(text).toContain('septa-g-trolley-tracker.netlify.app');
  });
});

describe('maybePostPcc', () => {
  it('posts the first car of the day, then threads later cars, once each', async () => {
    const { poster, client, setNow } = testPoster();
    const run = (t, cars, buses = 6) => {
      setNow(t);
      return maybePostPcc({ poster, pcc: { cars, buses }, shapes, basemap, now: t });
    };

    // Out under CONFIRM_MS: not yet.
    expect((await run(at(7, 2), [car('2324')])).posted).toBe(0);
    const first = await run(at(7, 0) + CONFIRM_MS, [car('2324')]);
    expect(first).toMatchObject({ cars: 1, posted: 1 });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].account).toBe('metro');
    expect(client.posts[0].opts.text).toMatch(/^🚋✨ A vintage PCC trolley is out/);
    expect(client.posts[0].opts.image).toBeTruthy();
    expect(poster.find('pcc:2026-10-10:2324', 'pcc')).toBeTruthy();

    // Same car, later: nothing new.
    expect((await run(at(7, 30), [car('2324')])).posted).toBe(0);

    // A second car comes out.
    const both = [car('2324'), car('2337', { first_seen_ts: at(8, 0), lon: -75.24 })];
    expect((await run(at(8, 2), both)).posted).toBe(0);
    expect((await run(at(8, 4), both)).posted).toBe(1);
    expect(client.posts).toHaveLength(2);
    const reply = client.posts[1];
    expect(reply.opts.text).toMatch(/^🚋 Another PCC is out on the G1: #2337/);
    expect(reply.opts.reply.root.uri).toBe(client.posts[0].uri);
    expect((await run(at(8, 6), both)).posted).toBe(0);
  });

  it('links the tracker when there is no map', async () => {
    const { poster, client } = testPoster();
    await maybePostPcc({
      poster,
      pcc: { cars: [car('2326')], buses: 4 },
      shapes: null,
      basemap,
      now: at(9, 0),
    });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].opts.text).toContain('#2326');
    expect(client.posts[0].opts.link.url).toBe('https://septa-g-trolley-tracker.netlify.app/');
  });

  it('does nothing without a status this tick', async () => {
    const { poster, client } = testPoster();
    expect(await maybePostPcc({ poster, pcc: null, basemap, now: at(9, 0) })).toBeNull();
    expect(client.posts).toHaveLength(0);
  });
});
