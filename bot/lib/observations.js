// Vehicle positions, polled every minute and kept for a few days: the raw
// material for timelapses, speed maps, and detector lookbacks.
import { railKeyForTrainViewLine } from '../../collector/lib/network.js';

/**
 * Record TransitView vehicles (normalizeTransitView output) and TrainView
 * trains in one transaction.
 * @returns {number} rows written
 */
export function recordObservations(db, ts, { vehicles = [], trains = [] }) {
  const insert = db.prepare(`
    INSERT INTO observations (ts, mode, route, vehicle_id, trip_id, direction, destination, lat, lon, heading, late_min, next_stop, report_ts)
    VALUES (@ts, @mode, @route, @vehicle_id, @trip_id, @direction, @destination, @lat, @lon, @heading, @late_min, @next_stop, @report_ts)
  `);
  let n = 0;
  db.transaction(() => {
    for (const v of vehicles) {
      insert.run({
        ts,
        mode: v.mode,
        route: v.route,
        vehicle_id: v.id,
        trip_id: v.tripId,
        direction: v.directionName,
        destination: v.destination,
        lat: v.lat,
        lon: v.lon,
        heading: v.heading ?? null,
        late_min: v.lateMin,
        next_stop: v.nextStopName,
        report_ts: v.reportTs,
      });
      n++;
    }
    for (const t of trains) {
      const lat = Number(t.lat);
      const lon = Number(t.lon);
      const route = railKeyForTrainViewLine(t.line);
      if (!route || !Number.isFinite(lat) || !Number.isFinite(lon) || !lat) continue;
      const late = Number(t.late);
      insert.run({
        ts,
        mode: 'regional_rail',
        route,
        vehicle_id: String(t.trainno),
        trip_id: String(t.trainno),
        direction: null,
        destination: t.dest ?? null,
        lat,
        lon,
        heading: Number.isFinite(Number(t.heading)) ? Number(t.heading) : null,
        late_min: Number.isFinite(late) && late < 900 ? late : null,
        next_stop: t.nextstop ?? null,
        report_ts: null,
      });
      n++;
    }
  })();
  return n;
}

/** Observations for routes since a time, oldest first. */
export function observationsSince(db, { routes = null, mode = null, since }) {
  const where = ['ts >= @since'];
  if (mode) where.push('mode = @mode');
  if (routes?.length) where.push(`route IN (${routes.map((_, i) => `@r${i}`).join(', ')})`);
  const params = { since, mode };
  routes?.forEach((r, i) => {
    params[`r${i}`] = r;
  });
  return db
    .prepare(`SELECT * FROM observations WHERE ${where.join(' AND ')} ORDER BY ts, vehicle_id`)
    .all(params);
}
