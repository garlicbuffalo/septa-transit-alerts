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
