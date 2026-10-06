import { useEffect, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { fetchEventTrack } from '../lib/eventTracks.js';
import { hexToRgba } from '../lib/format.js';
import { buildLineMap, sliceTrackBetween, terminalPointsFor } from '../lib/lineMap.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { displayStationName, slugifyStation } from '../lib/stations.js';

// Trains drop out of SEPTA feed for short stretches constantly (layovers at
// terminals, tunnels, missing predictions). We bridge gaps up to this long —
// interpolating straight through, since the train really is still running —
// because pulse-cold needs 15+ min of emptiness by definition, so an 8-min
// bridge still lets a genuinely cold stretch empty out. Past the cutoff the
// train isn't drawn through the unknown middle; it fades out at its last known
// spot and a ghost fades back in where it resurfaces.
const MAX_GAP_SEC = 480;
const STALE_FULL_SEC = 45; // within this of a real sample → full opacity
const BRIDGE_MIN_OPACITY = 0.5; // dimmest a dot gets while interpolated across a bridged gap
const GHOST_OPACITY = 0.5; // a parked dot at the edge of an un-bridgeable gap
// Playback-seconds over which a dot fades in/out at every appear, disappear,
// and gap boundary — so nothing pops; it eases. Kept short so it still reads at
// high speed.
const EDGE_FADE_SEC = 25;
// A 72-min window at 16× is still ~4.5 real minutes — accurate but tedious. The
// high multipliers make a whole incident watchable in well under a minute.
const SPEEDS = [8, 30, 60, 120];

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

// Position + opacity of one vehicle at playhead `t` (seconds from t0), or null
// when it shouldn't be drawn. Handles three things so dots never pop:
//   - edge fades at the train's first/last sample (entering/leaving service),
//   - mild dimming while a position is interpolated across a bridged gap,
//   - a fading "ghost" parked at the last/next known spot on either side of an
//     un-bridgeable gap, with nothing drawn through the unknown middle.
function vehicleSample(v, t, reducedMotion = false) {
  const s = v.s;
  if (!s || s.length === 0) return null;
  const first = s[0][0];
  const last = s[s.length - 1][0];
  if (t < first || t > last) return null;

  let i = 0;
  while (i < s.length - 1 && s[i + 1][0] <= t) i++;
  const a = s[i];
  const b = s[Math.min(i + 1, s.length - 1)];
  const gap = b[0] - a[0];

  let lat;
  let lon;
  let opacity;
  if (gap > MAX_GAP_SEC) {
    // Too long to bridge: park a ghost at the near endpoint for one fade, then
    // draw nothing until it fades back in approaching the far endpoint. Under
    // reduced motion there's no ghost fade — the dot is simply absent.
    if (reducedMotion) return null;
    const sinceA = t - a[0];
    const untilB = b[0] - t;
    if (sinceA <= EDGE_FADE_SEC) {
      lat = a[1];
      lon = a[2];
      opacity = GHOST_OPACITY * (1 - sinceA / EDGE_FADE_SEC);
    } else if (untilB <= EDGE_FADE_SEC) {
      lat = b[1];
      lon = b[2];
      opacity = GHOST_OPACITY * (1 - untilB / EDGE_FADE_SEC);
    } else {
      return null;
    }
  } else {
    const f = gap === 0 ? 0 : (t - a[0]) / gap;
    lat = a[1] + (b[1] - a[1]) * f;
    lon = a[2] + (b[2] - a[2]) * f;
    const stale = Math.min(t - a[0], b[0] - t);
    opacity =
      reducedMotion || stale <= STALE_FULL_SEC
        ? 1
        : Math.max(
            BRIDGE_MIN_OPACITY,
            1 -
              ((stale - STALE_FULL_SEC) / (MAX_GAP_SEC / 2 - STALE_FULL_SEC)) *
                (1 - BRIDGE_MIN_OPACITY),
          );
  }

  // Ease in/out at the train's own appearance and disappearance (skipped under
  // reduced motion).
  const edge = Math.min(t - first, last - t);
  if (!reducedMotion && edge < EDGE_FADE_SEC) opacity *= edge / EDGE_FADE_SEC;

  // Bracket endpoints (lat/lon) so the renderer can derive a heading — the
  // direction a → b is the train's travel direction along this segment.
  return { lat, lon, opacity, fromLL: [a[1], a[2]], toLL: [b[1], b[2]] };
}

// Center City (City Hall) — the aim point for "toward Center City"/"downtown"
// labels, which name a destination area rather than a single terminus station.
const DOWNTOWN_CENTER = [39.9524, -75.1636];

// A train whose last sample lands within this many px of a terminus (or
// Center City, where trolleys loop back) ran off the end of its line — a clean exit, not a
// data dropout. Beyond it, a stream that ends mid-route before the incident
// resolves is the feed losing the train; we mark that distinctly so it doesn't
// read as a train that simply left.
const TERMINUS_NEAR_PX = 20;
const DOWNTOWN_NEAR_PX = 40;
// How long (playback seconds) a "signal lost" ghost lingers, fading, at the last
// known spot after a mid-route disappearance.
const LOST_SIGNAL_HOLD_SEC = 90;

// Grace on each side of the detected window. The actual red/clear timing is
// driven by train presence; this just scopes "this is the incident" so the
// segment doesn't flash red on every normal headway gap elsewhere in the clip.
const COLD_PAD_MS = 120000;

// Is a train dot inside the affected segment right now? Bounding box of the two
// endpoint stations (trains ride the line, so the box ≈ the stretch).
function dotInBox(d, a, b, margin = 9) {
  return (
    d.x >= Math.min(a.x, b.x) - margin &&
    d.x <= Math.max(a.x, b.x) + margin &&
    d.y >= Math.min(a.y, b.y) - margin &&
    d.y <= Math.max(a.y, b.y) + margin
  );
}

// "toward Midway" → slug for matching a terminus station. Returns null for
// non-station phrasings like "toward Center City" (caller just skips the arrow).
function terminusSlug(directionLabel) {
  const m = directionLabel?.match(/toward\s+(.+)$/i);
  return m ? slugifyStation(m[1].trim()) : null;
}

// Placement {dx, dy, anchor} for each affected-station label, keyed by station
// name. A lone station — or a well-separated pair — rides centered above its
// dot, dropping below only to dodge the top edge so the text doesn't clip. Two
// stations that sit close together would otherwise collide, so:
//   • a vertical stack (e.g. two stations where a line bends sharply)
//     sets its labels *beside* the dots, like a real transit map — on the side
//     opposite the direction arrow so the two don't collide — instead of
//     stacked on top of the track;
//   • a side-by-side pair fans apart vertically (upper label up, lower down).
function affectedLabelOffsets(affected, width, height, arrowSide = 0) {
  const centered = (s) => ({ dx: 0, dy: s.y < height * 0.14 ? 15 : -9, anchor: 'middle' });
  const out = {};
  if (affected.length === 2) {
    const [a, b] = affected;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    const close = dx < 50 && dy < 80;
    if (close && dy >= dx) {
      // Vertical stack: labels beside the dots, fanned outward (upper label up,
      // lower label down) so each clears a horizontal track arm at its own dot's
      // level — e.g. a station at a sharp bend, so a label level with
      // it would land on the westbound arm. Sit on the side opposite the arrow
      // if there is one; otherwise the side toward the map's center (the more
      // open margin). Anchor so the text grows into open canvas, clear of the
      // ~6px dot ring.
      const side = arrowSide !== 0 ? -arrowSide : (a.x + b.x) / 2 > width / 2 ? -1 : 1;
      const anchor = side < 0 ? 'end' : 'start';
      const upper = a.y <= b.y ? a : b;
      const lower = a.y <= b.y ? b : a;
      out[upper.name] = { dx: side * 12, dy: -10, anchor };
      out[lower.name] = { dx: side * 12, dy: 15, anchor };
      return out;
    }
    if (close) {
      // Side-by-side pair: fan the labels apart vertically. Drop the lower one
      // below the pair; if that'd clip the bottom edge, lift the upper one.
      const upper = a.y <= b.y ? a : b;
      const lower = a.y <= b.y ? b : a;
      if (lower.y < height - 16) {
        out[upper.name] = centered(upper);
        out[lower.name] = { dx: 0, dy: 15, anchor: 'middle' };
      } else {
        out[upper.name] = { dx: 0, dy: -9, anchor: 'middle' };
        out[lower.name] = centered(lower);
      }
      return out;
    }
  }
  for (const s of affected) out[s.name] = centered(s);
  return out;
}

// SVG path for a full arrow (shaft + V head, like "→") centered at (x,y) and
// pointing along `ang`. Stroked, not filled.
function arrowPath(x, y, ang, len = 34, head = 11) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const tipX = x + c * (len / 2);
  const tipY = y + s * (len / 2);
  const tailX = x - c * (len / 2);
  const tailY = y - s * (len / 2);
  const wing = (da) =>
    `${(tipX - Math.cos(ang + da) * head).toFixed(1)},${(tipY - Math.sin(ang + da) * head).toFixed(1)}`;
  return `M${tailX.toFixed(1)},${tailY.toFixed(1)}L${tipX.toFixed(1)},${tipY.toFixed(1)}M${wing(0.5)}L${tipX.toFixed(1)},${tipY.toFixed(1)}L${wing(-0.5)}`;
}

// Snap a projected point onto the nearest point of the line's track polylines.
// A train's position comes from projecting its lat/lon (and linearly
// interpolating between samples), so on a bend the dot would chord across the
// corner; snapping pins it back onto the rendered track. O(track vertices) per
// dot — the polylines are short, so this is cheap each frame.
function snapToTracks(px, py, tracks) {
  let bx = px;
  let by = py;
  let best = Number.POSITIVE_INFINITY;
  for (const seg of tracks) {
    for (let i = 0; i < seg.length - 1; i++) {
      const a = seg[i];
      const b = seg[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const u =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
      const cx = a.x + u * dx;
      const cy = a.y + u * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
    }
  }
  return { x: bx, y: by };
}

// Triangular train marker pointing along heading `ang`, centered at (x,y) — so
// at a glance the two opposing streams of trains point opposite ways.
function triMarker(x, y, ang, size = 7.5) {
  const pt = (a, r) => `${(x + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r).toFixed(1)}`;
  const back = ang + Math.PI;
  return `M${pt(ang, size)}L${pt(back + 0.6, size)}L${pt(back - 0.6, size)}Z`;
}

// Per-polyline cumulative arc-length, so a projected point can be expressed as a
// scalar distance along the rail.
function withCumLengths(tracks) {
  return tracks
    .filter((seg) => seg.length >= 2)
    .map((seg) => {
      const cum = [0];
      for (let i = 1; i < seg.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
      }
      return { pts: seg, cum };
    });
}

// Arc-length of the nearest point on one polyline to (px,py), plus its squared
// distance (for picking the nearest polyline).
function arcLenOnPoly(px, py, poly) {
  let bestD = Number.POSITIVE_INFINITY;
  let bestS = 0;
  for (let i = 0; i < poly.pts.length - 1; i++) {
    const a = poly.pts[i];
    const b = poly.pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    const cx = a.x + u * dx;
    const cy = a.y + u * dy;
    const d = (px - cx) ** 2 + (py - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      bestS = poly.cum[i] + u * Math.sqrt(len2);
    }
  }
  return { s: bestS, d2: bestD };
}

// SEPTA train positions jitter — a train can report a position slightly *behind*
// its last one, which the renderer would draw as a stutter backward. Drop those
// regressions: express each sample as arc-length along the train's dominant
// polyline and keep only samples that advance (within a small tolerance) in the
// train's net travel direction. Endpoints are always kept.
const ARCLEN_TOL = 4; // px of arc-length — ignore sub-pixel/GPS wobble
function deJitterVehicle(samples, polys, project) {
  if (samples.length < 4 || polys.length === 0) return samples;
  const info = samples.map(([, lat, lon]) => {
    const p = project(lat, lon);
    let best = Number.POSITIVE_INFINITY;
    let poly = 0;
    let s = 0;
    for (let k = 0; k < polys.length; k++) {
      const r = arcLenOnPoly(p.x, p.y, polys[k]);
      if (r.d2 < best) {
        best = r.d2;
        poly = k;
        s = r.s;
      }
    }
    return { px: p.x, py: p.y, poly, s };
  });
  // Dominant polyline (most samples nearest it); re-measure s there for all.
  const counts = {};
  for (const r of info) counts[r.poly] = (counts[r.poly] ?? 0) + 1;
  const dom = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  for (const r of info) if (r.poly !== dom) r.s = arcLenOnPoly(r.px, r.py, polys[dom]).s;

  const dir = Math.sign(info[info.length - 1].s - info[0].s);
  if (dir === 0) return samples; // not really moving along the line
  const kept = [samples[0]];
  let highS = info[0].s;
  for (let i = 1; i < info.length - 1; i++) {
    if ((info[i].s - highS) * dir >= -ARCLEN_TOL) {
      kept.push(samples[i]);
      if ((info[i].s - highS) * dir > 0) highS = info[i].s;
    }
  }
  kept.push(samples[samples.length - 1]);
  return kept;
}

export default function EventReplay({ eventId, lineKey, fromStation, toStation, directionLabel }) {
  const [track, setTrack] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | none
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0); // playhead, seconds from track.t0
  const [speed, setSpeed] = useState(60);
  const rafRef = useRef(null);
  const lastRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetchEventTrack(eventId).then((data) => {
      if (cancelled) return;
      if (!data?.vehicles?.length) {
        setStatus('none');
        return;
      }
      setTrack(data);
      setT(0);
      setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // On a phone, render the line in portrait (long axis vertical) so it fills
  // the screen's height instead of squishing into a wide sliver.
  const isMobile = useMediaQuery('(max-width: 640px)');
  // Honor reduced-motion like the rest of the app (index.css kills looping
  // animations): drop the dot fade tweening and never auto-run. Playback itself
  // stays available — it's user-initiated.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const map = useMemo(
    () =>
      lineKey
        ? buildLineMap(
            lineKey,
            null,
            isMobile
              ? { maxWidth: 400, maxHeight: 640, margin: 16, preferPortrait: true }
              : { maxWidth: 720, maxHeight: 320 },
          )
        : null,
    [lineKey, isMobile],
  );

  // De-jittered vehicles — drop backward GPS regressions so trains don't stutter
  // backward. Memoized: depends only on the loaded track + the map projection.
  const vehicles = useMemo(() => {
    if (!track || !map) return [];
    const polys = withCumLengths(map.tracks);
    return track.vehicles.map((v) => ({ ...v, s: deJitterVehicle(v.s, polys, map.project) }));
  }, [track, map]);

  // Projected terminus stations of the line — anchors for telling a clean exit
  // (train ran off the end of its line) from a mid-route feed dropout.
  const terminalPts = useMemo(() => (map ? terminalPointsFor(map, lineKey) : []), [map, lineKey]);

  // Trains whose track simply *ends* mid-route, before the clip does and away
  // from any terminus or Center City — i.e. the feed lost them, they didn't
  // leave service. We mark these with a brief fading "signal lost" ring at their
  // last spot (below), so a data dropout reads differently from a train that
  // cleanly reached the end of its run. Memoized per loaded track.
  const lostSignalVehicles = useMemo(() => {
    if (!track || !map || track.durSec <= 0) return [];
    const downtownPt = map.project(DOWNTOWN_CENTER[0], DOWNTOWN_CENTER[1]);
    const out = [];
    for (const v of vehicles) {
      if (!v.s?.length) continue;
      const lastS = v.s[v.s.length - 1];
      const lastSec = lastS[0];
      // Must end clearly before the clip's end (else it's just the clip ending).
      if (lastSec >= track.durSec - 30) continue;
      const p = map.project(lastS[1], lastS[2]);
      const sn = snapToTracks(p.x, p.y, map.tracks);
      const nearTerminus = terminalPts.some(
        (tp) => Math.hypot(tp.x - sn.x, tp.y - sn.y) <= TERMINUS_NEAR_PX,
      );
      const nearDowntown = Math.hypot(downtownPt.x - sn.x, downtownPt.y - sn.y) <= DOWNTOWN_NEAR_PX;
      if (nearTerminus || nearDowntown) continue; // clean exit — not a dropout
      out.push({ id: v.id, dir: v.dir, lastSec, x: sn.x, y: sn.y });
    }
    return out;
  }, [track, map, vehicles, terminalPts]);

  // The actual "no service" intervals, scanned across the clip with the exact
  // same presence logic the map uses (segment empty of affected-direction trains
  // within the incident window). The scrubber bands these so it agrees with when
  // the map segment is red — rather than the detector's onset, which leads the
  // trains you can see. Memoized: runs once per loaded track.
  const coldBands = useMemo(() => {
    if (!track || !map || track.durSec <= 0) return [];
    const wanted = new Set([fromStation, toStation].filter(Boolean).map((n) => slugifyStation(n)));
    const aff = map.stations.filter((s) => wanted.has(slugifyStation(s.name)));
    if (aff.length !== 2) return [];
    const dir = track.affectedDir ?? null;
    const resMs = track.resolved ?? Number.POSITIVE_INFINITY;
    const step = Math.max(2, track.durSec / 250);
    const intervals = [];
    let start = null;
    for (let ts = 0; ts <= track.durSec; ts += step) {
      const clock = track.t0 + ts * 1000;
      const inWin = clock >= track.onset - COLD_PAD_MS && clock <= resMs + COLD_PAD_MS;
      let occupied = false;
      if (inWin) {
        for (const v of vehicles) {
          if (dir != null && v.dir !== dir) continue;
          const pos = vehicleSample(v, ts, false);
          if (!pos) continue;
          const p = map.project(pos.lat, pos.lon);
          const sn = snapToTracks(p.x, p.y, map.tracks);
          if (dotInBox({ x: sn.x, y: sn.y }, aff[0], aff[1])) {
            occupied = true;
            break;
          }
        }
      }
      const cold = inWin && !occupied;
      if (cold && start == null) start = ts;
      else if (!cold && start != null) {
        intervals.push([start, ts]);
        start = null;
      }
    }
    if (start != null) intervals.push([start, track.durSec]);
    return intervals;
  }, [track, map, vehicles, fromStation, toStation]);

  // rAF playback loop. Advances the playhead by wall-clock delta × speed.
  useEffect(() => {
    if (!playing || !track) return undefined;
    lastRef.current = null;
    const tick = (now) => {
      if (lastRef.current != null) {
        const dt = (now - lastRef.current) / 1000;
        setT((prev) => Math.min(prev + dt * speed, track.durSec));
      }
      lastRef.current = now;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, track, speed]);

  // Auto-stop at the end so the loop doesn't spin on a clamped playhead.
  useEffect(() => {
    if (track && t >= track.durSec) setPlaying(false);
  }, [t, track]);

  if (status !== 'ready' || !map || !track) return null;

  const info = METRO_LINES[lineKey];
  const accent = info?.color ?? '#475569';
  const trackPaths = map.tracks
    .filter((tr) => tr.length >= 2)
    .map((tr) => `M${tr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`);

  const wanted = new Set([fromStation, toStation].filter(Boolean).map((n) => slugifyStation(n)));
  const affected = map.stations.filter((s) => wanted.has(slugifyStation(s.name)));
  const highlightPath =
    affected.length === 2 ? sliceTrackBetween(map.tracks, affected[0], affected[1]) : null;

  const clockMs = track.t0 + t * 1000;

  const dots = [];
  for (const v of vehicles) {
    const pos = vehicleSample(v, t, reducedMotion);
    if (!pos) continue;
    const p = map.project(pos.lat, pos.lon);
    const snapped = snapToTracks(p.x, p.y, map.tracks);
    // Heading from the projected bracket direction (a → b). Below a tiny
    // threshold the train is effectively still → no arrow, just a dot.
    const pf = map.project(pos.fromLL[0], pos.fromLL[1]);
    const pt = map.project(pos.toLL[0], pos.toLL[1]);
    const hdx = pt.x - pf.x;
    const hdy = pt.y - pf.y;
    const ang = hdx * hdx + hdy * hdy > 1 ? Math.atan2(hdy, hdx) : null;
    dots.push({ id: v.id, dir: v.dir, x: snapped.x, y: snapped.y, opacity: pos.opacity, ang });
  }

  // "Signal lost" rings: a train whose feed went dark mid-route lingers as a
  // fading hollow ring at its last spot for a short window, so the dropout is
  // legible as a data gap rather than a silent disappearance. Skipped under
  // reduced motion (no fade), matching how the dot ghosts are suppressed there.
  const lostGhosts = reducedMotion
    ? []
    : lostSignalVehicles
        .map((v) => {
          const age = t - v.lastSec;
          if (age < 0 || age > LOST_SIGNAL_HOLD_SEC) return null;
          return { ...v, opacity: 0.55 * (1 - age / LOST_SIGNAL_HOLD_SEC) };
        })
        .filter(Boolean);

  // Drive the "no service" highlight off whether a train is *physically* in the
  // segment right now (gated to the incident window), not the detector's
  // onset/resolved timestamps — which lead and lag the trains you can see. So
  // it turns red only once the last train clears the stretch, and snaps back the
  // instant one re-enters.
  const inWindow =
    clockMs >= track.onset - COLD_PAD_MS &&
    clockMs <= (track.resolved ?? Number.POSITIVE_INFINITY) + COLD_PAD_MS;
  // Only trains traveling in the *affected* direction count toward "is the
  // segment occupied" — an opposite-direction train passing through must not
  // clear a one-directional cold. affectedDir is baked in by the archiver
  // (matched from the direction label's terminus to the destination text);
  // null means undirected, so any train counts.
  const affectedDir = track.affectedDir ?? null;
  const segOccupied =
    affected.length === 2 &&
    dots.some(
      (d) =>
        (affectedDir == null || d.dir === affectedDir) && dotInBox(d, affected[0], affected[1]),
    );
  const coldActive = inWindow && affected.length === 2 && !segOccupied;

  // Band the scrubber with the actual "no service" intervals (coldBands), so it
  // agrees with when the map segment is red. Fall back to the detector's
  // onset→resolved window only if presence never resolved a cold stretch.
  const onsetSec = Math.max(0, Math.min(track.durSec, (track.onset - track.t0) / 1000));
  const resolvedSec =
    track.resolved != null
      ? Math.max(0, Math.min(track.durSec, (track.resolved - track.t0) / 1000))
      : track.durSec;
  const bandSegs =
    track.durSec > 0
      ? (coldBands.length > 0 ? coldBands : [[onsetSec, resolvedSec]]).map(([a, c]) => ({
          left: (a / track.durSec) * 100,
          width: (Math.max(0, c - a) / track.durSec) * 100,
        }))
      : [];

  // Arrow marking the affected direction of travel, pointing toward the named
  // terminus. Best-effort: only drawn when the direction label resolves to a
  // station on this line.
  const termSlug = terminusSlug(directionLabel);
  let targetPt = termSlug
    ? (map.stations.find((s) => slugifyStation(s.name) === termSlug) ?? null)
    : null;
  // "toward Center City"/"downtown" isn't a station — aim at the downtown end.
  if (!targetPt && /center city|downtown/i.test(directionLabel ?? '')) {
    targetPt = map.project(DOWNTOWN_CENTER[0], DOWNTOWN_CENTER[1]);
  }
  let directionArrow = null;
  let arrowSide = 0; // horizontal side the arrow took: -1 left, +1 right, 0 none
  if (highlightPath && targetPt && affected.length === 2) {
    const d0 = Math.hypot(affected[0].x - targetPt.x, affected[0].y - targetPt.y);
    const d1 = Math.hypot(affected[1].x - targetPt.x, affected[1].y - targetPt.y);
    const near = d0 <= d1 ? affected[0] : affected[1];
    const far = d0 <= d1 ? affected[1] : affected[0];
    const ang = Math.atan2(near.y - far.y, near.x - far.x); // travel direction
    // Float the arrow off to the side of the segment (perpendicular to it), not
    // on the track where it blends in. Offset from the segment midpoint, and
    // pick whichever side sits farther from the map center so it lands in open
    // margin rather than over other track.
    const midX = (affected[0].x + affected[1].x) / 2;
    const midY = (affected[0].y + affected[1].y) / 2;
    const cx = map.width / 2;
    const cy = map.height / 2;
    const [base] = [ang + Math.PI / 2, ang - Math.PI / 2]
      .map((pa) => ({ x: midX + Math.cos(pa) * 30, y: midY + Math.sin(pa) * 30 }))
      .sort((p, q) => Math.hypot(q.x - cx, q.y - cy) - Math.hypot(p.x - cx, p.y - cy));
    directionArrow = arrowPath(base.x, base.y, ang);
    arrowSide = Math.sign(base.x - midX);
  }

  // Labels for a vertical stack go to the side opposite the arrow, so the two
  // don't fight over the same margin (arrowSide drives that choice).
  const labelPos = affectedLabelOffsets(affected, map.width, map.height, arrowSide);

  const segLabel =
    fromStation && toStation
      ? `${displayStationName(fromStation)} → ${displayStationName(toStation)}`
      : null;

  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
        ▶ Watch it unfold
      </h2>
      {segLabel && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {segLabel}
          {directionLabel ? ` · ${directionLabel}` : ''}
        </p>
      )}
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        {/* Mobile: portrait line, sized to the screen's height and centered.
            Desktop: a wide landscape line — give it a minimum render width and
            let the card scroll horizontally rather than shrink to specks. */}
        <div className={isMobile ? 'flex justify-center' : 'overflow-x-auto -mx-1 px-1'}>
          <svg
            viewBox={`0 0 ${map.width} ${map.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Replay of trains on the ${info?.label ?? lineKey} Line`}
            className="block"
            style={
              isMobile
                ? { height: 'min(560px, 64vh)', width: 'auto', maxWidth: '100%' }
                : { width: '100%', height: 'auto', minWidth: Math.min(map.width, 560) }
            }
          >
            <title>{`Replay of ${dots.length} trains on the ${info?.label ?? lineKey} Line`}</title>
            {trackPaths.map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                stroke={hexToRgba(accent, 0.22)}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {highlightPath && (
              <path
                d={highlightPath}
                fill="none"
                stroke={coldActive ? '#ef4444' : hexToRgba(accent, 0.4)}
                strokeWidth={coldActive ? 6 : 4}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={coldActive ? '2 6' : undefined}
                opacity={0.9}
              />
            )}
            {/* Quiet station dots for context. */}
            {map.stations.map((s) => (
              <circle
                key={s.name}
                cx={s.x}
                cy={s.y}
                r={affected.includes(s) ? 5 : 2.5}
                fill={affected.includes(s) ? 'none' : '#cbd5e1'}
                stroke={affected.includes(s) ? accent : 'none'}
                strokeWidth={affected.includes(s) ? 2.5 : 0}
                className={affected.includes(s) ? '' : 'dark:[fill:#475569]'}
              >
                <title>{displayStationName(s.name)}</title>
              </circle>
            ))}
            {/* Affected-direction arrow — drawn above the station pins (with a
                halo) so it stays legible against the track and dots. */}
            {directionArrow && (
              <g strokeLinecap="round" strokeLinejoin="round" fill="none">
                {/* Halo underneath for legibility over the track + dots. */}
                <path
                  d={directionArrow}
                  stroke="white"
                  strokeWidth={6}
                  className="dark:[stroke:#0d1117]"
                />
                <path d={directionArrow} stroke={coldActive ? '#ef4444' : accent} strokeWidth={3} />
              </g>
            )}
            {/* "Signal lost" rings — a hollow dashed circle where a train's feed
                went dark mid-route, fading over a few seconds. Distinct from a
                train that cleanly ran off at a terminus (which just exits). */}
            {lostGhosts.map((g) => (
              <circle
                key={`lost-${g.id}`}
                cx={g.x}
                cy={g.y}
                r={7}
                fill="none"
                stroke={accent}
                strokeWidth={2}
                strokeDasharray="2 3"
                opacity={g.opacity}
              >
                <title>{`Run ${g.id} · signal lost`}</title>
              </circle>
            ))}
            {/* Live train dots. Moving trains render as an arrowhead pointing
                the way they're headed (so opposing streams separate at a
                glance); stationary ones stay a plain dot. Opacity drops as a
                dot's position is bridged across a feed gap. */}
            {dots.map((d) => (
              <g key={d.id} opacity={d.opacity}>
                <circle cx={d.x} cy={d.y} r={9} fill={hexToRgba(accent, 0.25)} />
                {d.ang != null ? (
                  <path
                    d={triMarker(d.x, d.y, d.ang)}
                    fill={accent}
                    stroke="white"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    className="dark:[stroke:#0d1117]"
                  >
                    <title>{`Run ${d.id}`}</title>
                  </path>
                ) : (
                  <circle
                    cx={d.x}
                    cy={d.y}
                    r={5.5}
                    fill={accent}
                    stroke="white"
                    strokeWidth={2}
                    className="dark:[stroke:#0d1117]"
                  >
                    <title>{`Run ${d.id}`}</title>
                  </circle>
                )}
              </g>
            ))}
            {/* Affected-station labels — drawn last (with a halo) so you can
                read which stations frame the gap without hovering. Placement
                (above/below the dot, or beside it for tight stacks) is resolved
                up front by affectedLabelOffsets so close pairs don't collide. */}
            {affected.map((s) => (
              <text
                key={`lbl-${s.name}`}
                x={s.x + labelPos[s.name].dx}
                y={s.y + labelPos[s.name].dy}
                textAnchor={labelPos[s.name].anchor}
                fontSize={9.5}
                fontWeight={600}
                fill={accent}
                stroke="white"
                strokeWidth={2.75}
                className="dark:[stroke:#0d1117]"
                style={{ paintOrder: 'stroke' }}
              >
                {displayStationName(s.name)}
              </text>
            ))}
          </svg>
        </div>

        {/* Controls */}
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => {
              if (t >= track.durSec) setT(0);
              setPlaying((p) => !p);
            }}
            className="px-3 py-1.5 rounded-md bg-slate-800 text-white text-sm font-medium dark:bg-slate-200 dark:text-slate-900 min-w-[72px]"
          >
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <div className="flex-1 min-w-[160px]">
            {/* Disruption band: red spans mark when the segment is actually out
                of service (matches the map), so you can scrub right to it. */}
            {bandSegs.length > 0 && (
              <div
                className="relative h-1.5 mb-1 rounded bg-slate-200 dark:bg-gh-border"
                title={`no service${directionLabel ? ` · ${directionLabel}` : ''}`}
              >
                {bandSegs.map((b) => (
                  <div
                    key={`${b.left.toFixed(2)}-${b.width.toFixed(2)}`}
                    className="absolute inset-y-0 rounded bg-red-400/80 dark:bg-red-500/70"
                    style={{ left: `${b.left}%`, width: `${b.width}%` }}
                  />
                ))}
              </div>
            )}
            <input
              type="range"
              min={0}
              max={track.durSec}
              step={1}
              value={Math.round(t)}
              onChange={(e) => {
                setPlaying(false);
                setT(Number(e.target.value));
              }}
              className="w-full accent-slate-700 dark:accent-slate-300"
              aria-label="Scrub replay"
            />
          </div>
          <div className="flex items-center gap-1">
            {SPEEDS.map((sp) => (
              <button
                type="button"
                key={sp}
                onClick={() => setSpeed(sp)}
                className={`px-2 py-1 rounded text-xs font-medium ${
                  speed === sp
                    ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                    : 'bg-slate-100 text-slate-600 dark:bg-gh-border dark:text-slate-300'
                }`}
              >
                {sp}×
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            {fmtClock(clockMs)} · {dots.length} train{dots.length === 1 ? '' : 's'} on the line
          </span>
          {coldActive && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
              no service{directionLabel ? ` · ${directionLabel}` : segLabel ? ` · ${segLabel}` : ''}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
