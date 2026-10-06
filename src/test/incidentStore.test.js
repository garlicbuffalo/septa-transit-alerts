import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStoreCaches,
  getIncidentById,
  getIncidentWithContext,
  loadIndex,
  loadLine,
  loadMonth,
  loadRange,
  loadRecent,
  phillyMonthKey,
} from '../lib/incidentStore.js';

// Build a minimal v2 incident. The store only touches id/mode/routes for
// gating + id resolution; lifecycle is enough for the rest.
function incident(id, { mode = 'metro', routes = ['l1'] } = {}) {
  return {
    id,
    mode,
    routes,
    lifecycle: { first_seen_ts: 0, resolved_ts: 0, active: false },
    detections: [],
  };
}

// A fetch mock keyed by the trailing path of the requested URL, so each test
// declares exactly the files it expects to be hit and asserts on cache modes.
function mockFiles(files) {
  const calls = [];
  globalThis.fetch = vi.fn((url, opts) => {
    // Data URLs are same-origin `/data/<file>` by default (dataSource.js).
    const path = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/data\//, '');
    calls.push({ path, cache: opts?.cache });
    if (!(path in files)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(files[path]) });
  });
  return calls;
}

beforeEach(() => {
  __resetStoreCaches();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('phillyMonthKey', () => {
  it('honors the Philadelphia timezone boundary', () => {
    // 2026-06-01T03:00Z is still 2026-05-31 23:00 in Philadelphia (EDT, -4).
    expect(phillyMonthKey(Date.parse('2026-06-01T03:00:00Z'))).toBe('2026-05');
    expect(phillyMonthKey(Date.parse('2026-06-01T05:00:00Z'))).toBe('2026-06');
  });
});

describe('loadRecent', () => {
  it('fetches the recent file with revalidation', async () => {
    const calls = mockFiles({
      'alerts-recent.json': {
        generated_at: 5,
        incidents: [incident('a'), incident('m', { mode: 'regional_rail' })],
      },
    });
    const out = await loadRecent();
    expect(out.generated_at).toBe(5);
    // Every mode is kept — there is no per-mode gate.
    expect(out.incidents.map((i) => i.id)).toEqual(['a', 'm']);
    expect(calls[0]).toEqual({ path: 'alerts-recent.json', cache: 'no-cache' });
  });
});

describe('loadMonth', () => {
  it('force-caches + memoizes a closed month (one fetch for repeat calls)', async () => {
    const calls = mockFiles({
      'alerts/2020-01.json': { month: '2020-01', incidents: [incident('old')] },
    });
    const first = await loadMonth('2020-01');
    const second = await loadMonth('2020-01');
    expect(first.map((i) => i.id)).toEqual(['old']);
    expect(second).toBe(first); // memoized promise result
    expect(calls).toHaveLength(1);
    // `default` (not force-cache): honors the shard's 1-day TTL so a late
    // resolution that rewrites a closed month is picked up within ~24h.
    expect(calls[0].cache).toBe('default');
  });

  it('revalidates the current month and does not memoize it', async () => {
    const key = phillyMonthKey(Date.now());
    const calls = mockFiles({
      [`alerts/${key}.json`]: { month: key, incidents: [incident('cur')] },
    });
    await loadMonth(key);
    await loadMonth(key);
    expect(calls).toHaveLength(2); // not memoized
    expect(calls[0].cache).toBe('no-cache');
  });
});

describe('loadLine', () => {
  it('encodes the key, memoizes, and gates', async () => {
    const calls = mockFiles({
      'incidents/by-line/72%20North%20Ave.json': {
        line: '72 North Ave',
        incidents: [incident('x', { routes: ['72 North Ave'] })],
      },
    });
    await loadLine('72 North Ave');
    await loadLine('72 North Ave');
    expect(calls).toHaveLength(1); // memoized
    expect(calls[0].cache).toBe('no-cache');
  });
});

describe('getIncidentById', () => {
  it('resolves from the recent slice without touching the index', async () => {
    const calls = mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [incident('here')] },
    });
    const res = await getIncidentById('here');
    expect(res.incident.id).toBe('here');
    expect(res.incidents.map((i) => i.id)).toEqual(['here']);
    expect(calls.map((c) => c.path)).toEqual(['alerts-recent.json']);
  });

  it('falls back to the id→month shard via the index for archived ids', async () => {
    mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [incident('recent')] },
      'alerts-index.json': { months: [], lines: [], id_month: { gone: '2020-01' } },
      'alerts/2020-01.json': { month: '2020-01', incidents: [incident('gone')] },
    });
    const res = await getIncidentById('gone');
    expect(res.incident.id).toBe('gone');
    expect(res.incidents.map((i) => i.id)).toEqual(['gone']);
  });

  it('resolves an archived non-canonical post rkey via rkey_month', async () => {
    const canon = {
      id: 'canon',
      mode: 'metro',
      routes: ['l1'],
      lifecycle: { first_seen_ts: 0, resolved_ts: 0, active: false },
      detections: [{ post_url: 'https://bsky.app/profile/did/post/botrkey' }],
    };
    mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [incident('recent')] },
      'alerts-index.json': {
        months: [],
        lines: [],
        id_month: {},
        rkey_month: { botrkey: '2020-01' },
      },
      'alerts/2020-01.json': { month: '2020-01', incidents: [canon] },
    });
    const res = await getIncidentById('botrkey');
    expect(res.incident.id).toBe('canon');
  });

  it('returns null when the id resolves nowhere', async () => {
    mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [incident('recent')] },
      'alerts-index.json': { months: [], lines: [], id_month: {}, rkey_month: {} },
    });
    expect(await getIncidentById('missing')).toBeNull();
    expect(await getIncidentById('')).toBeNull();
  });
});

describe('getIncidentWithContext', () => {
  it('unions the incident slice with adjacent months and its line files', async () => {
    const may = Date.parse('2026-05-10T12:00:00Z');
    const e2 = {
      id: 'e2',
      mode: 'metro',
      routes: ['l1'],
      lifecycle: { first_seen_ts: may, resolved_ts: may, active: false },
      detections: [],
    };
    mockFiles({
      // Archived: not in the recent slice, so it resolves via the index → month.
      'alerts-recent.json': { generated_at: 1, incidents: [] },
      'alerts-index.json': {
        // Newest-first; e2's month (2026-05) sits between two existing months.
        months: [
          { key: '2026-06', url: 'alerts/2026-06.json', count: 1, min_ts: 0, max_ts: 0 },
          { key: '2026-05', url: 'alerts/2026-05.json', count: 1, min_ts: 0, max_ts: 0 },
          { key: '2026-04', url: 'alerts/2026-04.json', count: 1, min_ts: 0, max_ts: 0 },
        ],
        lines: [],
        id_month: { e2: '2026-05' },
        rkey_month: {},
      },
      'alerts/2026-05.json': { month: '2026-05', incidents: [e2] },
      'alerts/2026-04.json': { month: '2026-04', incidents: [incident('apr')] },
      'alerts/2026-06.json': { month: '2026-06', incidents: [incident('jun')] },
      // Same-line neighbor that sits outside the ±1 month window.
      'incidents/by-line/l1.json': { line: 'l1', incidents: [e2, incident('lineOld')] },
    });
    const res = await getIncidentWithContext('e2');
    expect(res.incident.id).toBe('e2');
    expect(res.incidents.map((i) => i.id).sort()).toEqual(['apr', 'e2', 'jun', 'lineOld']);
  });

  it('only requests adjacent months that exist in the index (no future-month 404)', async () => {
    const jun = Date.parse('2026-06-10T12:00:00Z');
    const e3 = {
      id: 'e3',
      mode: 'metro',
      routes: ['l1'],
      lifecycle: { first_seen_ts: jun, resolved_ts: jun, active: false },
      detections: [],
    };
    const calls = mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [] },
      'alerts-index.json': {
        // 2026-06 is the newest month — there is no newer neighbor to fetch.
        months: [
          { key: '2026-06', url: 'alerts/2026-06.json', count: 1, min_ts: 0, max_ts: 0 },
          { key: '2026-05', url: 'alerts/2026-05.json', count: 1, min_ts: 0, max_ts: 0 },
        ],
        lines: [],
        id_month: { e3: '2026-06' },
        rkey_month: {},
      },
      'alerts/2026-06.json': { month: '2026-06', incidents: [e3] },
      'alerts/2026-05.json': { month: '2026-05', incidents: [incident('may')] },
      'incidents/by-line/l1.json': { line: 'l1', incidents: [e3] },
    });
    const res = await getIncidentWithContext('e3');
    expect(res.incidents.map((i) => i.id).sort()).toEqual(['e3', 'may']);
    // The non-existent next month must never be requested.
    expect(calls.some((c) => c.path === 'alerts/2026-07.json')).toBe(false);
  });

  it('returns null for an unresolvable id', async () => {
    mockFiles({
      'alerts-recent.json': { generated_at: 1, incidents: [] },
      'alerts-index.json': { months: [], lines: [], id_month: {}, rkey_month: {} },
    });
    expect(await getIncidentWithContext('nope')).toBeNull();
  });
});

describe('loadRange', () => {
  it('unions only the months overlapping the range, de-duped by id', async () => {
    mockFiles({
      'alerts-index.json': {
        months: [
          { key: '2020-01', url: 'alerts/2020-01.json', count: 1, min_ts: 100, max_ts: 200 },
          { key: '2020-02', url: 'alerts/2020-02.json', count: 1, min_ts: 300, max_ts: 400 },
          { key: '2020-03', url: 'alerts/2020-03.json', count: 1, min_ts: 500, max_ts: 600 },
        ],
        lines: [],
        id_month: {},
      },
      'alerts/2020-02.json': { month: '2020-02', incidents: [incident('feb')] },
      'alerts/2020-03.json': { month: '2020-03', incidents: [incident('mar')] },
    });
    // Range [350, 550] overlaps Feb (300-400) and Mar (500-600), not Jan.
    const out = await loadRange(350, 550);
    expect(out.map((i) => i.id).sort()).toEqual(['feb', 'mar']);
  });
});

describe('loadIndex', () => {
  it('memoizes across calls', async () => {
    const calls = mockFiles({
      'alerts-index.json': { months: [], lines: [], id_month: {} },
    });
    await loadIndex();
    await loadIndex();
    expect(calls).toHaveLength(1);
    expect(calls[0].cache).toBe('no-cache');
  });
});
