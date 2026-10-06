// Distances for post text and timelapse readouts.

const M_PER_DEG = 111_320;

/** Flat-earth distance in meters, plenty accurate across a city. */
export function metersBetween(a, b) {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG * k);
}

/** Largest distance between any two of the points, in meters. */
export function maxPairDistance(points) {
  let max = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      max = Math.max(max, metersBetween(points[i], points[j]));
  return max;
}

/** Length of a [[lat, lon], …] polyline in meters. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += metersBetween(
      { lat: points[i - 1][0], lon: points[i - 1][1] },
      { lat: points[i][0], lon: points[i][1] },
    );
  }
  return total;
}

/** "450 ft" under 1,000 ft, else "0.42 mi". */
export function formatDistance(meters) {
  const ft = meters * 3.28084;
  return ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(ft / 5280).toFixed(2)} mi`;
}

/**
 * A [[lat, lon], …] shape with each point's distance from the start (m),
 * for locating positions along it.
 */
export function measureShape(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(
      cum[i - 1] +
        metersBetween(
          { lat: points[i - 1][0], lon: points[i - 1][1] },
          { lat: points[i][0], lon: points[i][1] },
        ),
    );
  }
  return { points, cum, length: cum.at(-1) ?? 0 };
}

/** How far along a measured shape a position is, and how far off it (m). */
export function locateAlong(measured, p) {
  const { points, cum } = measured;
  const k = Math.cos((p.lat * Math.PI) / 180);
  let best = { along: 0, off: Infinity };
  for (let i = 0; i + 1 < points.length; i++) {
    const [aLat, aLon] = points[i];
    const [bLat, bLon] = points[i + 1];
    const dx = (bLon - aLon) * k;
    const dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    const t = len2
      ? Math.max(0, Math.min(1, ((p.lon - aLon) * k * dx + (p.lat - aLat) * dy) / len2))
      : 0;
    const off = Math.hypot((p.lon - aLon) * k - t * dx, p.lat - aLat - t * dy) * M_PER_DEG;
    if (off < best.off) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), off };
  }
  return best;
}

/** The part of a measured shape between two distances along it. */
export function sliceAlong(measured, from, to) {
  const { points, cum } = measured;
  const at = (d) => {
    let i = 0;
    while (i + 1 < cum.length - 1 && cum[i + 1] < d) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[i]) / seg));
    return [
      points[i][0] + t * (points[i + 1][0] - points[i][0]),
      points[i][1] + t * (points[i + 1][1] - points[i][1]),
    ];
  };
  const out = [at(from)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > from && cum[i] < to) out.push(points[i]);
  out.push(at(to));
  return out;
}
