// Vehicle tracks for timelapses: each vehicle's reports in time order, and
// where to draw it at any moment. SEPTA's tracker refreshes a vehicle every
// 20–30 seconds, so positions between reports are interpolated in a straight
// line. A vehicle that stops reporting stays put and fades out, and a short
// dropout is bridged, dimmed. Adapted from cta-insights' timelapse frame
// builder (ISC), which bridged dropouts up to 8 minutes the same way.

const BRIDGE_MS = 8 * 60 * 1000; // interpolate across dropouts up to this long
const DIM_AFTER_MS = 3 * 60 * 1000; // …drawn dimmed when longer than this
const HOLD_MS = 3 * 60 * 1000; // after a vehicle's last report: stay, then fade out
const FADE_AFTER_MS = 90 * 1000;
const LEAD_MS = 90 * 1000; // show a vehicle this long before its first report

/**
 * Group samples into tracks by vehicle.
 * @param {Iterable<{ vehicle_id: string, label?: string, route: string, t: number,
 *   lat: number, lon: number, late_min?: number | null, estimated?: number | boolean }>} samples
 * @returns {Map<string, { id: string, label: string, route: string,
 *   points: Array<{ t: number, lat: number, lon: number, late: number | null, est: boolean }> }>}
 *   est: placed by the schedule (an L1 train in the tunnel), not measured
 */
export function buildTracks(samples) {
  const tracks = new Map();
  for (const s of samples) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || !Number.isFinite(s.t)) continue;
    const id = String(s.vehicle_id);
    if (!tracks.has(id)) {
      tracks.set(id, { id, label: String(s.label ?? id), route: s.route, points: [] });
    }
    tracks.get(id).points.push({
      t: s.t,
      lat: s.lat,
      lon: s.lon,
      late: s.late_min ?? null,
      est: Boolean(s.estimated),
    });
  }
  for (const track of tracks.values()) {
    track.points.sort((a, b) => a.t - b.t);
    // One point per report time (the same report is often seen in two polls).
    track.points = track.points.filter((p, i, a) => i === 0 || p.t !== a[i - 1].t);
  }
  return tracks;
}

/**
 * Where to draw a vehicle at time t: { lat, lon, opacity, late, est }, or null
 * when it shouldn't be drawn.
 */
export function positionAt(track, t) {
  const pts = track.points;
  if (!pts.length) return null;
  const first = pts[0];
  if (t < first.t) return first.t - t <= LEAD_MS ? { ...first, opacity: 1 } : null;
  const last = pts[pts.length - 1];
  if (t >= last.t) {
    const age = t - last.t;
    if (age > HOLD_MS) return null;
    const opacity =
      age <= FADE_AFTER_MS ? 1 : Math.max(0, 1 - (age - FADE_AFTER_MS) / (HOLD_MS - FADE_AFTER_MS));
    return { ...last, opacity };
  }
  // Binary search for the report at or before t.
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = b.t - a.t;
  if (span > BRIDGE_MS) {
    // A long dropout: hold, then fade, as after a last report.
    const age = t - a.t;
    if (age > HOLD_MS) return null;
    return { ...a, opacity: age <= FADE_AFTER_MS ? 1 : 0.5 };
  }
  const f = span ? (t - a.t) / span : 0;
  return {
    t,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    late: f < 0.5 ? a.late : b.late,
    est: f < 0.5 ? a.est : b.est,
    opacity: span > DIM_AFTER_MS ? 0.5 : 1,
  };
}

/** Recent path for a comet trail: positions over [t − trailMs, t], oldest first. */
export function trailAt(track, t, { trailMs = 75_000, stepMs = 5000 } = {}) {
  const out = [];
  for (let s = t - trailMs; s <= t; s += stepMs) {
    const p = positionAt(track, s);
    if (p && p.opacity > 0) out.push(p);
  }
  return out;
}

/** The vehicle's last reported position at or before t (within the hold), or null. */
export function lastKnown(track, t) {
  let found = null;
  for (const p of track.points) {
    if (p.t > t) break;
    found = p;
  }
  return found && t - found.t <= HOLD_MS ? found : null;
}
