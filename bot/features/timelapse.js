// Timelapse videos, ported from cta-insights (ISC):
//
// - After a gap, bunching, or cross-route cluster post, the bot records the
//   vehicles involved for the next 10 minutes (one poll of their route every
//   15 seconds) and replies with a video of what happened: did the bunch
//   spread out, did the gap close, did the cluster clear.
// - Five times a day, a 15-minute system snapshot of every tracked bus (bus
//   account) and every Metro trolley and M1 car (metro account), colored by
//   how late each is running.
//
// Captures live in SQLite (captures, capture_samples), so a restart mid-
// capture loses nothing but the polls it missed; the minute-by-minute
// observations fill those in.
import { easternDateKey, easternParts } from '../../collector/lib/time.js';
import { screenVehicles } from '../../collector/lib/vehicleScreen.js';
import { normalizeTransitView } from '../../collector/lib/vehicles.js';
import { clockRange } from '../lib/clock.js';
import { formatDistance, maxPairDistance, metersBetween } from '../lib/geo.js';
import { routeShortLabel } from '../lib/routes.js';
import { routeColor } from '../map/routeMap.js';
import {
  alongRoute,
  focusScene,
  latenessKey,
  nearestShape,
  snapshotLines,
  snapshotScene,
  TRACKED_METRO,
} from '../video/scenes.js';
import { renderTimelapse } from '../video/timelapse.js';
import { buildTracks, positionAt } from '../video/tracks.js';
import { startOfEasternDay } from './history.js';

export const CAPTURE_MS = 10 * 60 * 1000;
export const SNAPSHOT_MS = 15 * 60 * 1000;
// Playback: one frame per 3.75 s of real time at 16 fps, so ten minutes
// plays in ten seconds.
const REAL_MS_PER_FRAME = 3750;
// Let the last polls land before rendering.
const SETTLE_MS = 20_000;
const MAX_ACTIVE = 6;
const MAX_ATTEMPTS = 2;
// Bluesky limits how many videos an account can upload a day. Detection
// timelapses get at most one per account and kind an hour, and leave room
// in the day for the snapshots.
export const VIDEO_LIMITS = { dailyPerAccount: 20, snapshotsPerDay: 5, perKindPerHour: 1 };
const VIDEO_KINDS = ['timelapse', 'snapshot'];
// The evening-rush snapshots (5 PM) are highlighted for the insights account.
const RUSH_SNAPSHOT = /T17$/;

const json = (s) => (s ? JSON.parse(s) : null);

/** The raw route id TransitView's per-route endpoint takes. */
export function rawRouteId(mode, route) {
  return mode === 'metro' ? String(route).toUpperCase() : String(route);
}

/**
 * Record a capture to start now. Returns its id, or null when one already
 * exists for this subject.
 */
export function startCapture(
  db,
  { kind, subject, account, mode, routes = null, focus = null, replyUri = null, start, durationMs },
) {
  const res = db
    .prepare(`
      INSERT OR IGNORE INTO captures (kind, subject, account, mode, routes, focus, reply_uri, start_ts, end_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      kind,
      subject,
      account,
      mode,
      routes ? JSON.stringify(routes) : null,
      focus ? JSON.stringify(focus) : null,
      replyUri,
      start,
      start + durationMs,
      start,
    );
  return res.changes ? Number(res.lastInsertRowid) : null;
}

const LIVE = "status NOT IN ('failed', 'skipped')";

/** Why a detection timelapse can't start now, or null when it can. */
export function captureBlocked(db, { account, kind, now, limits = VIDEO_LIMITS }) {
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM captures WHERE status IN ('capturing', 'rendering') AND kind != 'snapshot'",
    )
    .get().n;
  if (active >= MAX_ACTIVE) return 'busy';
  const lastHour = db
    .prepare(
      `SELECT COUNT(*) AS n FROM captures WHERE account = ? AND kind = ? AND start_ts >= ? AND ${LIVE}`,
    )
    .get(account, kind, now - 60 * 60 * 1000).n;
  if (lastHour >= limits.perKindPerHour) return 'hourly';
  const today = db
    .prepare(
      `SELECT COUNT(*) AS n FROM captures WHERE account = ? AND kind != 'snapshot' AND start_ts >= ? AND ${LIVE}`,
    )
    .get(account, startOfEasternDay(now)).n;
  if (today >= limits.dailyPerAccount - limits.snapshotsPerDay) return 'daily';
  return null;
}

/**
 * Start a timelapse for a just-posted detection, if the limits allow.
 * @param {{ kind: 'gap' | 'bunching' | 'cluster', subject: string, account: string,
 *   mode: string, routes: string[], directionId?: number | null, title: string,
 *   header: string, noun: string, vehicles: Array<{ id: string, label: string, tag: string,
 *   route?: string, color?: string }>, post: { uri: string }, now: number }} opts
 */
export function startDetectionCapture(db, opts, { limits = VIDEO_LIMITS } = {}) {
  const { kind, subject, account, mode, routes, post, now } = opts;
  if (!post?.uri || (opts.vehicles?.length ?? 0) < 2) return null;
  if (captureBlocked(db, { account, kind, now, limits })) return null;
  return startCapture(db, {
    kind,
    subject,
    account,
    mode,
    routes,
    focus: {
      title: opts.title,
      header: opts.header,
      noun: opts.noun,
      direction_id: opts.directionId ?? null,
      vehicles: opts.vehicles,
    },
    replyUri: post.uri,
    start: now,
    durationMs: CAPTURE_MS,
  });
}

/** Start the bus and Metro snapshots (once per hour slot). */
export function startSnapshots(
  db,
  { now, hasAccount = () => true, durationMs = SNAPSHOT_MS, slot = null },
) {
  const p = easternParts(now);
  const key = slot ?? `${easternDateKey(now)}T${String(p.hour).padStart(2, '0')}`;
  const started = [];
  for (const mode of ['bus', 'metro']) {
    if (!hasAccount(mode)) continue;
    const id = startCapture(db, {
      kind: 'snapshot',
      subject: `snapshot:${mode}:${key}`,
      account: mode,
      mode,
      start: now,
      durationMs,
    });
    if (id) started.push(mode);
  }
  return started;
}

/**
 * One sampling tick: poll what the running captures need and record it.
 * Snapshots need the whole feed; detection captures poll just their routes.
 * Positions that are nowhere near their trip's shape are left out, so a bad fix can't draw a
 * vehicle across the city in the video.
 * @param {{ db: object, sources: { transitView: Function, transitViewRoute: Function },
 *   shapes?: object | null, now: number, log?: (m: string) => void }} opts
 */
export async function sampleCaptures({ db, sources, shapes = null, now, log = () => {} }) {
  const active = db
    .prepare(
      "SELECT * FROM captures WHERE status = 'capturing' AND start_ts <= ? AND end_ts + ? >= ?",
    )
    .all(now, SETTLE_MS, now);
  if (active.length === 0) return { captures: 0, samples: 0 };
  let vehicles = [];
  if (active.some((c) => c.routes == null)) {
    try {
      vehicles = normalizeTransitView(await sources.transitView(), now).vehicles;
    } catch (err) {
      log(`timelapse: TransitView failed: ${err.message}`);
    }
  } else {
    const wanted = new Map();
    for (const c of active) {
      for (const route of json(c.routes) ?? []) wanted.set(`${c.mode}|${route}`, [c.mode, route]);
    }
    const results = await Promise.allSettled(
      [...wanted.values()].map(async ([mode, route]) => {
        const raw = rawRouteId(mode, route);
        const body = await sources.transitViewRoute(raw);
        const list = Array.isArray(body?.bus) ? body.bus : [];
        return normalizeTransitView({ routes: [{ [raw]: list }] }, now).vehicles;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') vehicles.push(...r.value);
      else log(`timelapse: route poll failed: ${r.reason?.message ?? r.reason}`);
    }
  }
  vehicles = screenVehicles(vehicles, { shapes, now }).vehicles;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO capture_samples (capture_id, vehicle_id, label, route, t, lat, lon, late_min)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let samples = 0;
  db.transaction(() => {
    for (const c of active) {
      const routes = json(c.routes);
      const wantedRoutes = routes ? new Set(routes) : null;
      for (const v of vehicles) {
        if (wantedRoutes ? !wantedRoutes.has(v.route) : v.mode !== c.mode) continue;
        samples += insert.run(
          c.id,
          v.id,
          v.label,
          v.route,
          v.reportTs,
          v.lat,
          v.lon,
          v.lateMin,
        ).changes;
      }
    }
  })();
  return { captures: active.length, samples };
}

/** Samples for a capture: its own polls plus the minute-by-minute observations. */
export function captureSamples(db, capture) {
  const own = db.prepare('SELECT * FROM capture_samples WHERE capture_id = ?').all(capture.id);
  const routes = json(capture.routes);
  const from = capture.start_ts - 3 * 60_000;
  const to = capture.end_ts + 60_000;
  const where = ['ts >= ?', 'ts <= ?'];
  const params = [from, to];
  if (routes) {
    where.push(`route IN (${routes.map(() => '?').join(', ')})`);
    params.push(...routes);
  } else {
    where.push('mode = ?');
    params.push(capture.mode);
  }
  const observed = db
    .prepare(
      `SELECT vehicle_id, vehicle_id AS label, route, COALESCE(report_ts, ts) AS t, lat, lon, late_min FROM observations WHERE ${where.join(' AND ')}`,
    )
    .all(...params);
  return [...own, ...observed];
}

// ---- Post text ------------------------------------------------------------

const visibleAt = (list, t) => list.map((v) => ({ v, p: v.track ? positionAt(v.track, t) : null }));

/** What happened to a bunch: spread out, or still bunched. */
export function bunchingOutcome(focusTracks, { start, end, noun }) {
  const atStart = visibleAt(focusTracks, start).filter((x) => x.p);
  const atEnd = visibleAt(focusTracks, end).filter((x) => x.p);
  if (atEnd.length < 2) {
    const lost = focusTracks.length - atEnd.length;
    return `${lost} of the ${focusTracks.length} ${noun} dropped off SEPTA's tracker.`;
  }
  const spanEnd = maxPairDistance(atEnd.map((x) => x.p));
  const spanStart = atStart.length >= 2 ? maxPairDistance(atStart.map((x) => x.p)) : null;
  if (spanStart != null && spanEnd >= Math.max(2 * spanStart, 400)) {
    return `The ${noun} spread out: ${formatDistance(spanStart)} → ${formatDistance(spanEnd)} from first to last.`;
  }
  return `Still bunched: ${atEnd.length} ${noun} within ${formatDistance(spanEnd)}${spanStart != null ? ` (was ${formatDistance(spanStart)})` : ''}.`;
}

/** How the gap between the last vehicle seen (L) and the next one (N) changed. */
export function gapOutcome(focusTracks, { start, end, shape }) {
  const [l, n] = focusTracks;
  const s = visibleAt([l, n], start);
  const e = visibleAt([l, n], end);
  const names = `#${l.label} (L) and #${n.label} (N)`;
  if (!e[0].p || !e[1].p) {
    const gone = [!e[0].p && `#${l.label}`, !e[1].p && `#${n.label}`].filter(Boolean);
    return `${gone.join(' and ')} dropped off SEPTA's tracker.`;
  }
  const after = alongRoute(shape, e[1].p, e[0].p);
  if (!s[0].p || !s[1].p) return `${names} were ${formatDistance(after)} apart.`;
  const before = alongRoute(shape, s[1].p, s[0].p);
  return `The gap between ${names} went from ${formatDistance(before)} to ${formatDistance(after)}.`;
}

/** How many of a cluster's vehicles moved on. */
export function clusterOutcome(focusTracks, { start, end, noun }) {
  const total = focusTracks.length;
  let still = 0;
  for (const v of focusTracks) {
    const a = v.track ? positionAt(v.track, start) : null;
    const b = v.track ? positionAt(v.track, end) : null;
    if (a && b && metersBetween(a, b) <= 150) still++;
  }
  if (still === total) return `All ${total} ${noun} were still there.`;
  if (still === 0) return `All ${total} ${noun} had moved on.`;
  return `${total - still} of the ${total} ${noun} had moved on; ${still} still there.`;
}

/** Snapshot post text: window, counts, and lateness (bus) or per-line counts (Metro). */
export function snapshotText({ mode, tracks, start, end }) {
  const all = [...tracks.values()];
  const at = (t) => all.map((tr) => ({ tr, p: positionAt(tr, t) })).filter((x) => x.p);
  const first = at(start);
  const last = at(end);
  const noun = mode === 'metro' ? 'vehicles' : 'buses';
  const minutes = `${Math.round((end - start) / 60000)}-minute timelapse`;
  const head =
    mode === 'metro'
      ? `🚋 SEPTA Metro trolleys and M1 · ${minutes}`
      : `🚌 SEPTA buses · ${minutes}`;
  const window = `${clockRange(start, end)} · ${first.length} → ${last.length} ${noun} on the tracker`;
  let detail;
  if (mode === 'metro') {
    const byLine = new Map(TRACKED_METRO.map((k) => [k, 0]));
    for (const x of last)
      if (byLine.has(x.tr.route)) byLine.set(x.tr.route, byLine.get(x.tr.route) + 1);
    detail = [...byLine]
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${routeShortLabel('metro', k)} ${n}`)
      .join(' · ');
  } else {
    const known = last.filter((x) => x.p.late != null);
    const share = (key) =>
      Math.round((100 * known.filter((x) => latenessKey(x.p.late) === key).length) / known.length);
    detail =
      known.length >= 10
        ? `On time or up to 5 min late: ${share('ontime')}% · 10+ min late: ${share('verylate')}%`
        : null;
  }
  const text = [head, window, detail].filter(Boolean).join('\n\n');
  const alt =
    mode === 'metro'
      ? `Timelapse map of every SEPTA Metro trolley and M1 car on SEPTA's tracker, ${clockRange(start, end)}, each dot colored by how late it's running.`
      : `Timelapse map of every bus on SEPTA's tracker, ${clockRange(start, end)}, each dot colored by how late it's running.`;
  return { text, alt };
}

// ---- Rendering ------------------------------------------------------------

export function routeLayers(capture, focus, shapes) {
  const routes = json(capture.routes) ?? [];
  const byRoute = new Map(
    (focus?.vehicles ?? []).filter((v) => v.color).map((v) => [v.route, v.color]),
  );
  // A route's short-turns, branches and extensions aren't on its busiest shape: draw each
  // followed vehicle's own trip's shape, as the post's map does.
  const own = (route) => {
    const lines = [];
    for (const v of focus?.vehicles ?? []) {
      const points = v.route === route && v.tripId ? shapes?.tripShape(v.tripId) : null;
      if (points && !lines.includes(points)) lines.push(points);
    }
    return capture.kind === 'cluster' ? [] : lines;
  };
  return routes.map((route) => {
    const color = byRoute.get(route) ?? routeColor(capture.mode, route);
    const ownShapes = own(route);
    if (ownShapes.length) return { route, color, shapes: ownShapes };
    const dirShape =
      capture.kind !== 'cluster' && focus?.direction_id != null
        ? shapes?.shape(route, focus.direction_id)
        : null;
    return {
      route,
      color,
      shapes: dirShape ? [dirShape] : (shapes?.shapes(route) ?? []),
    };
  });
}

/**
 * Build a capture's video and post text, or null when there's nothing to show.
 */
export async function buildCaptureVideo(
  db,
  capture,
  { shapes, basemap, encode, ffmpeg, frames = null },
) {
  const tracks = buildTracks(captureSamples(db, capture));
  const start = capture.start_ts;
  const end = capture.end_ts;
  const frameCount = frames ?? Math.round((end - start) / REAL_MS_PER_FRAME);
  if (capture.kind === 'snapshot') {
    if (tracks.size === 0) return null;
    const mode = capture.mode;
    const scene = snapshotScene({
      capture,
      mode,
      title: `${mode === 'metro' ? 'SEPTA Metro' : 'SEPTA buses'} · ${Math.round((end - start) / 60000)} minutes`,
      noun: mode === 'metro' ? 'vehicles' : 'buses',
      tracks,
      lines: snapshotLines(mode, shapes),
    });
    if (!scene) return null;
    const { text, alt } = snapshotText({ mode, tracks, start, end });
    const video = await renderTimelapse({
      ...scene,
      start,
      end,
      basemap,
      frames: frameCount,
      encode,
      ffmpeg,
    });
    return { text, alt, video };
  }

  const focus = json(capture.focus);
  const routes = routeLayers(capture, focus, shapes);
  const scene = focusScene({ capture, focus, routes, tracks });
  if (!scene) return null;
  const focusTracks = focus.vehicles.map((v) => ({ ...v, track: tracks.get(v.id) ?? null }));
  const ctx = { start, end, noun: focus.noun };
  const outcome =
    capture.kind === 'gap'
      ? gapOutcome(focusTracks, {
          ...ctx,
          shape: nearestShape(
            routes.flatMap((r) => r.shapes),
            focusTracks.map((v) => (v.track ? positionAt(v.track, start) : null)).filter(Boolean),
          ),
        })
      : capture.kind === 'cluster'
        ? clusterOutcome(focusTracks, ctx)
        : bunchingOutcome(focusTracks, ctx);
  const text = `${focus.header}\n\n${outcome}`;
  const alt = `Timelapse map of the ${Math.round((end - start) / 60000)} minutes after the post: ${outcome}`;
  const video = await renderTimelapse({
    ...scene,
    start,
    end,
    basemap,
    frames: frameCount,
    encode,
    ffmpeg,
  });
  return { text, alt, video };
}

function videosPostedToday(db, account, now, dryRun) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE account = ? AND kind IN (${VIDEO_KINDS.map(() => '?').join(', ')}) AND ts >= ? AND dry_run = ?`,
    )
    .get(account, ...VIDEO_KINDS, startOfEasternDay(now), dryRun ? 1 : 0).n;
}

/**
 * Render and post the next finished capture (one per call; the scheduler
 * calls this every 30 seconds).
 */
export async function renderDueCapture({
  db,
  poster,
  shapes,
  basemap,
  now,
  encode,
  ffmpeg,
  frames = null,
  limits = VIDEO_LIMITS,
  log = () => {},
}) {
  const setStatus = (id, status, note = null) =>
    db
      .prepare('UPDATE captures SET status = ?, note = ?, updated_ts = ? WHERE id = ?')
      .run(status, note, now, id);
  // Nothing renders between calls, so a capture still marked rendering was
  // interrupted (a restart): try it again, once.
  db.prepare(
    "UPDATE captures SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'capturing' END WHERE status = 'rendering'",
  ).run(MAX_ATTEMPTS);
  const capture = db
    .prepare(
      "SELECT * FROM captures WHERE status = 'capturing' AND end_ts <= ? ORDER BY end_ts LIMIT 1",
    )
    .get(now - SETTLE_MS);
  if (!capture) return null;
  db.prepare(
    "UPDATE captures SET status = 'rendering', attempts = attempts + 1, updated_ts = ? WHERE id = ?",
  ).run(now, capture.id);
  const label = `${capture.kind} ${capture.subject}`;
  try {
    if (!poster.client.hasAccount(capture.account)) {
      setStatus(capture.id, 'skipped', 'no-account');
      return { skipped: 'no-account' };
    }
    if (videosPostedToday(db, capture.account, now, poster.dryRun) >= limits.dailyPerAccount) {
      setStatus(capture.id, 'skipped', 'daily-cap');
      return { skipped: 'daily-cap' };
    }
    const built = await buildCaptureVideo(db, capture, {
      shapes,
      basemap,
      encode,
      ffmpeg,
      frames,
    });
    if (!built) {
      setStatus(capture.id, 'skipped', 'no-positions');
      return { skipped: 'no-positions' };
    }
    const video = {
      data: built.video.data,
      alt: built.alt,
      width: built.video.width,
      height: built.video.height,
    };
    const post =
      capture.kind === 'snapshot'
        ? await poster.post({
            account: capture.account,
            kind: 'snapshot',
            subject: capture.subject,
            text: built.text,
            video,
            highlight: RUSH_SNAPSHOT.test(capture.subject) ? 'rush-hour' : null,
          })
        : await poster.post({
            account: capture.account,
            kind: 'timelapse',
            subject: capture.subject,
            reply: capture.reply_uri,
            requireParent: true,
            text: built.text,
            video,
          });
    if (!post) {
      setStatus(capture.id, 'skipped', 'parent-gone');
      return { skipped: 'parent-gone' };
    }
    setStatus(capture.id, 'done');
    log(`timelapse: posted ${label} (${(video.data.length / 1e6).toFixed(1)} MB)`);
    return { posted: capture.kind, url: post.url };
  } catch (err) {
    const row = db.prepare('SELECT attempts FROM captures WHERE id = ?').get(capture.id);
    const retry = row.attempts < MAX_ATTEMPTS;
    setStatus(capture.id, retry ? 'capturing' : 'failed', err.message.slice(0, 500));
    log(`timelapse: ${label} failed${retry ? ', will retry' : ''}: ${err.message}`);
    return { error: err.message };
  }
}

/** Header line for a detection timelapse reply. */
export function timelapseHeader(mode, route, toward = '') {
  return `🎬 ${routeShortLabel(mode, route)}${toward} · the next 10 minutes`;
}
