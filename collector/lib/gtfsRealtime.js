// Minimal GTFS-realtime decoder for SEPTA's bus/Metro feeds — just enough
// protobuf to read each trip's id, route, direction, and schedule relationship
// from TripUpdates (SEPTA marks cancelled trips CANCELED there), and each
// vehicle's position from VehiclePositions (where the Market-Frankford Line's
// cars report, with no trip; see subwayTrains.js). No dependencies.
//
// Wire format reference: https://gtfs.org/realtime/reference/
//   FeedMessage   1: header (FeedHeader)   2: entity (FeedEntity, repeated)
//   FeedHeader    3: timestamp (uint64, POSIX seconds)
//   FeedEntity    1: id   2: is_deleted   3: trip_update (TripUpdate)   4: vehicle (VehiclePosition)
//   TripUpdate    1: trip (TripDescriptor)
//   TripDescriptor 1: trip_id  3: start_date  4: schedule_relationship  5: route_id
//                  6: direction_id
//   VehiclePosition 1: trip (TripDescriptor)  2: position (Position)  5: timestamp (uint64)
//                   8: vehicle (VehicleDescriptor)
//   Position      1: latitude  2: longitude  3: bearing  5: speed (m/s) — all float
//   VehicleDescriptor 1: id  2: label

export const SCHEDULE_RELATIONSHIP = {
  0: 'SCHEDULED',
  1: 'ADDED',
  2: 'UNSCHEDULED',
  3: 'CANCELED',
  5: 'REPLACEMENT',
  6: 'DUPLICATED',
  7: 'DELETED',
};

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos++];
    // Multiply rather than shift past 31 bits: timestamps exceed int32.
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [result, pos];
    if (shift > 63) throw new Error('varint too long');
  }
}

/** Decode one protobuf message into [{ field, wire, value }] (value: number | Buffer). */
export function decodeFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('truncated field');
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    out.push({ field, wire, value });
  }
  return out;
}

const first = (fields, n) => fields.find((f) => f.field === n)?.value;
const str = (v) => (v == null ? null : Buffer.from(v).toString('utf8'));

/**
 * Decode a TripUpdates FeedMessage into its trips.
 * @param {Buffer | Uint8Array} buffer
 * @returns {{ timestamp: number | null, trips: Array<{ tripId: string, routeId: string | null,
 *   directionId: number | null, startDate: string | null, relationship: string }> }}
 */
export function decodeTripUpdates(buffer) {
  const buf = Buffer.from(buffer);
  const top = decodeFields(buf);
  const header = first(top, 1);
  const ts = header ? first(decodeFields(header), 3) : null;
  const trips = [];
  for (const { field, value } of top) {
    if (field !== 2) continue;
    const entity = decodeFields(value);
    if (first(entity, 2) === 1) continue; // is_deleted
    const update = first(entity, 3);
    if (!update) continue;
    const descriptor = first(decodeFields(update), 1);
    if (!descriptor) continue;
    const d = decodeFields(descriptor);
    const tripId = str(first(d, 1));
    if (!tripId) continue;
    trips.push({
      tripId,
      routeId: str(first(d, 5)),
      directionId: first(d, 6) ?? null,
      startDate: str(first(d, 3)),
      relationship: SCHEDULE_RELATIONSHIP[first(d, 4) ?? 0] ?? 'SCHEDULED',
    });
  }
  return { timestamp: typeof ts === 'number' ? ts * 1000 : null, trips };
}

const float = (v) => (v?.length === 4 ? Buffer.from(v).readFloatLE(0) : null);

/**
 * Decode a VehiclePositions FeedMessage into its vehicles. A vehicle without a position is left
 * out; one without a trip (SEPTA's subway cars) has null trip fields.
 * @param {Buffer | Uint8Array} buffer
 * @returns {{ timestamp: number | null, vehicles: Array<{ vehicleId: string, label: string | null,
 *   tripId: string | null, routeId: string | null, directionId: number | null, lat: number,
 *   lon: number, bearing: number | null, speed: number | null, reportTs: number | null }> }}
 *   reportTs: when the vehicle's position was measured (ms), or null when the feed doesn't say
 */
export function decodeVehiclePositions(buffer) {
  const buf = Buffer.from(buffer);
  const top = decodeFields(buf);
  const header = first(top, 1);
  const ts = header ? first(decodeFields(header), 3) : null;
  const vehicles = [];
  for (const { field, value } of top) {
    if (field !== 2) continue;
    const entity = decodeFields(value);
    if (first(entity, 2) === 1) continue; // is_deleted
    const vp = first(entity, 4);
    if (!vp) continue;
    const v = decodeFields(vp);
    const position = first(v, 2);
    if (!position) continue;
    const p = decodeFields(position);
    const lat = float(first(p, 1));
    const lon = float(first(p, 2));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
    const descriptor = first(v, 8);
    const d = descriptor ? decodeFields(descriptor) : [];
    const trip = first(v, 1);
    const t = trip ? decodeFields(trip) : [];
    const vehicleId = str(first(d, 1)) ?? str(first(entity, 1));
    if (!vehicleId) continue;
    const reportTs = first(v, 5);
    vehicles.push({
      vehicleId,
      label: str(first(d, 2)),
      tripId: str(first(t, 1)) || null,
      routeId: str(first(t, 5)) || null,
      directionId: first(t, 6) ?? null,
      lat,
      lon,
      bearing: float(first(p, 3)),
      speed: float(first(p, 5)),
      reportTs: typeof reportTs === 'number' ? reportTs * 1000 : null,
    });
  }
  return { timestamp: typeof ts === 'number' ? ts * 1000 : null, vehicles };
}

// --- Encoding (tests and fixtures only) -------------------------------------
function encodeVarint(n) {
  const bytes = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
const tag = (field, wire) => encodeVarint(field * 8 + wire);
const lenField = (field, payload) =>
  Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
const intField = (field, n) => Buffer.concat([tag(field, 0), encodeVarint(n)]);

/**
 * Encode trips as a TripUpdates FeedMessage — the inverse of decodeTripUpdates,
 * used to build test fixtures.
 */
export function encodeTripUpdates({ timestamp = null, trips = [] }) {
  const parts = [];
  const header = [lenField(1, Buffer.from('2.0'))];
  if (timestamp != null) header.push(intField(3, Math.floor(timestamp / 1000)));
  parts.push(lenField(1, Buffer.concat(header)));
  const codes = Object.fromEntries(Object.entries(SCHEDULE_RELATIONSHIP).map(([k, v]) => [v, +k]));
  trips.forEach((t, i) => {
    const d = [lenField(1, Buffer.from(t.tripId))];
    if (t.startDate) d.push(lenField(3, Buffer.from(t.startDate)));
    d.push(intField(4, codes[t.relationship ?? 'SCHEDULED'] ?? 0));
    if (t.routeId) d.push(lenField(5, Buffer.from(t.routeId)));
    if (t.directionId != null) d.push(intField(6, t.directionId));
    const update = lenField(1, Buffer.concat(d));
    parts.push(
      lenField(2, Buffer.concat([lenField(1, Buffer.from(String(i + 1))), lenField(3, update)])),
    );
  });
  return Buffer.concat(parts);
}

function floatField(field, x) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x, 0);
  return Buffer.concat([tag(field, 5), b]);
}

/**
 * Encode vehicles as a VehiclePositions FeedMessage — the inverse of decodeVehiclePositions,
 * used to build test fixtures.
 */
export function encodeVehiclePositions({ timestamp = null, vehicles = [] }) {
  const parts = [];
  const header = [lenField(1, Buffer.from('2.0'))];
  if (timestamp != null) header.push(intField(3, Math.floor(timestamp / 1000)));
  parts.push(lenField(1, Buffer.concat(header)));
  vehicles.forEach((v, i) => {
    const fields = [];
    if (v.tripId || v.routeId) {
      const d = [];
      if (v.tripId) d.push(lenField(1, Buffer.from(v.tripId)));
      if (v.routeId) d.push(lenField(5, Buffer.from(v.routeId)));
      if (v.directionId != null) d.push(intField(6, v.directionId));
      fields.push(lenField(1, Buffer.concat(d)));
    }
    const p = [floatField(1, v.lat), floatField(2, v.lon)];
    if (v.bearing != null) p.push(floatField(3, v.bearing));
    if (v.speed != null) p.push(floatField(5, v.speed));
    fields.push(lenField(2, Buffer.concat(p)));
    if (v.reportTs != null) fields.push(intField(5, Math.floor(v.reportTs / 1000)));
    const d = [lenField(1, Buffer.from(String(v.vehicleId)))];
    d.push(lenField(2, Buffer.from(String(v.label ?? v.vehicleId))));
    fields.push(lenField(8, Buffer.concat(d)));
    parts.push(
      lenField(
        2,
        Buffer.concat([
          lenField(1, Buffer.from(String(v.entityId ?? i + 1))),
          lenField(4, Buffer.concat(fields)),
        ]),
      ),
    );
  });
  return Buffer.concat(parts);
}
