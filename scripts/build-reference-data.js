// Generate the bundled SEPTA reference data (stations, line geometry, bus route
// names) from SEPTA's public GTFS bundle. Run by hand whenever SEPTA publishes
// a new GTFS release that changes stations or alignments — the output is
// committed, so the site build and the collector never download GTFS.
//
//   node scripts/build-reference-data.js                 # download from SEPTA
//   node scripts/build-reference-data.js path/to/gtfs_public.zip
//
// SEPTA publishes one outer zip holding two inner GTFS feeds:
//   google_bus.zip  — buses, trackless trolleys, and SEPTA Metro (L/B/M/T/G/D)
//   google_rail.zip — Regional Rail
//
// Outputs (src/lib/):
//   metroStations.json    [{ name, lat, lon, lines: ['l1', …] }] — one record per
//                         physical station, shared across the lines serving it
//   metroLineShapes.json  { lineKey: [[[lat, lon], …], …] } — simplified track
//   railStations.json     { lineKey: [{ id, name, lat, lon }] } — outer terminal
//                         first, Center City last
//   railLineShapes.json   { lineKey: [[[lat, lon], …], …] }
//   busRoutes.json        { routeId: longName } in SEPTA's display order
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'src', 'lib');
const GTFS_URL = 'https://www3.septa.org/developer/gtfs_public.zip';

// SEPTA Metro route_ids in display order. Street-running trolley lines (T, G)
// list every corner stop in GTFS; only their subway stations and terminals are
// kept as "stations" (see keepMetroStop).
export const METRO_ROUTE_IDS = [
  'L1',
  'B1',
  'B2',
  'B3',
  'M1',
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'G1',
  'D1',
  'D2',
];
const STREET_RUNNING = new Set(['T1', 'T2', 'T3', 'T4', 'T5', 'G1']);

// Center City Regional Rail stations, used to orient each line outer → city.
const RAIL_CENTER_CITY = new Set([
  'Penn Medicine Station',
  'Gray 30th St Station',
  'Suburban Station',
  'Jefferson Station',
  'Temple University',
]);

// --- Minimal zip reader -------------------------------------------------------
// Reads the central directory and inflates individual entries. Enough for GTFS
// (stored or deflated entries, no zip64, no encryption).
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`zip entry not found: ${name}`);
      const lh = e.localOffset;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
    },
  };
}

// --- CSV ----------------------------------------------------------------------
// GTFS CSV: quoted fields may contain commas; no embedded newlines in SEPTA's
// feed, but handle "" escapes. Streams rows to a callback to keep the 18 MB
// shapes.txt from materializing as one giant array of objects.
function eachCsvRow(text, onRow) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] ?? '';
    onRow(row);
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function csvRows(zip, name) {
  const rows = [];
  eachCsvRow(zip.read(name).toString('utf8'), (r) => rows.push(r));
  return rows;
}

// --- Geometry -----------------------------------------------------------------
const round5 = (x) => Math.round(x * 1e5) / 1e5;

// Douglas–Peucker on [lat, lon] pairs; tolerance in degrees (~1e-4 ≈ 10 m).
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = points[a];
    const [by, bx] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = points[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]).map(([lat, lon]) => [round5(lat), round5(lon)]);
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Read shapes.txt, keeping only the wanted shape ids.
function loadShapes(zip, wanted) {
  const pts = new Map();
  eachCsvRow(zip.read('shapes.txt').toString('utf8'), (r) => {
    if (!wanted.has(r.shape_id)) return;
    if (!pts.has(r.shape_id)) pts.set(r.shape_id, []);
    pts
      .get(r.shape_id)
      .push([Number(r.shape_pt_sequence), Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
  });
  const out = new Map();
  for (const [id, list] of pts) {
    list.sort((a, b) => a[0] - b[0]);
    out.set(
      id,
      list.map(([, lat, lon]) => [lat, lon]),
    );
  }
  return out;
}

// Pick the distinct track alignments for a route: the most-used shape per
// direction-0 terminal pair, so branches (T3 Yeadon vs Darby, AIR, …) each
// draw once without stacking dozens of near-identical short-turn variants.
function routeShapes(trips, routeId) {
  const usage = new Map();
  for (const t of trips) {
    if (t.route_id !== routeId || !t.shape_id) continue;
    if (t.direction_id !== '0') continue;
    usage.set(t.shape_id, (usage.get(t.shape_id) || 0) + 1);
  }
  return [...usage.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function pickAlignments(shapeIds, shapes, maxCount = 4) {
  const chosen = [];
  for (const id of shapeIds) {
    const pts = shapes.get(id);
    if (!pts || pts.length < 2) continue;
    const first = { lat: pts[0][0], lon: pts[0][1] };
    const last = { lat: pts[pts.length - 1][0], lon: pts[pts.length - 1][1] };
    // Skip a variant whose endpoints both lie on (within 300 m of) an already
    // chosen alignment — it's a short-turn of a drawn route.
    const covered = chosen.some((c) =>
      [first, last].every((p) => c.some(([lat, lon]) => haversineM(p, { lat, lon }) < 300)),
    );
    if (covered) continue;
    chosen.push(pts);
    if (chosen.length >= maxCount) break;
  }
  return chosen.map((pts) => simplify(pts, 0.00008));
}

// --- Station naming -----------------------------------------------------------
function cleanMetroStopName(name) {
  return String(name)
    .replace(/^69th St TC West Trolley Platform$/, '69th St Transit Center')
    .replace(/\s+-\s+(B\d(\s*&\s*B\d)?|MBFS|MBNS|FS|NS)$/i, '')
    .trim();
}

function keepMetroStop(routeId, name, index, total) {
  if (index === 0 || index === total - 1) return true;
  if (!STREET_RUNNING.has(routeId)) return true;
  // Street-running trolleys: keep subway stations / named stations, drop
  // "Baltimore Av & 59th St"-style corner stops.
  return !name.includes('&');
}

// --- Main ---------------------------------------------------------------------
async function loadOuterZip(arg) {
  if (arg) return readFileSync(arg);
  console.log(`build-reference-data: downloading ${GTFS_URL}`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading GTFS`);
  return Buffer.from(await res.arrayBuffer());
}

function buildMetro(bus) {
  const stops = new Map(csvRows(bus, 'stops.txt').map((r) => [r.stop_id, r]));
  const routeStops = csvRows(bus, 'route_stops.txt');
  const trips = csvRows(bus, 'trips.txt');

  // Physical stations, merged across lines by cleaned name when within 400 m.
  const stations = [];
  const findStation = (name, lat, lon) =>
    stations.find((s) => s.name === name && haversineM(s, { lat, lon }) < 400);

  for (const routeId of METRO_ROUTE_IDS) {
    const lineKey = routeId.toLowerCase();
    const ordered = routeStops
      .filter((r) => r.route_id === routeId && r.direction_id === '0')
      .sort((a, b) => Number(a.route_stop_sort_order) - Number(b.route_stop_sort_order))
      .map((r) => stops.get(r.stop_id))
      .filter(Boolean);
    // `seq[lineKey]` is the station's position along that line (direction 0),
    // so consumers can enumerate the stations between two endpoints.
    let seq = 0;
    ordered.forEach((stop, i) => {
      const name = cleanMetroStopName(stop.stop_name);
      if (!keepMetroStop(routeId, name, i, ordered.length)) return;
      const lat = round5(Number(stop.stop_lat));
      const lon = round5(Number(stop.stop_lon));
      const existing = findStation(name, lat, lon);
      if (existing) {
        if (!existing.lines.includes(lineKey)) existing.lines.push(lineKey);
        if (existing.seq[lineKey] == null) existing.seq[lineKey] = seq++;
      } else {
        stations.push({ name, lat, lon, lines: [lineKey], seq: { [lineKey]: seq++ } });
      }
    });
  }

  // Disambiguate same-named, physically distinct stations with the first
  // serving line's label, mirroring the `Central (Green)` convention.
  const byName = new Map();
  for (const s of stations) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (const s of list) s.name = `${name} (${s.lines[0].toUpperCase()})`;
  }

  const wanted = new Set();
  const shapeIdsByRoute = new Map();
  for (const routeId of METRO_ROUTE_IDS) {
    const ids = routeShapes(trips, routeId);
    shapeIdsByRoute.set(routeId, ids);
    for (const id of ids) wanted.add(id);
  }
  const shapes = loadShapes(bus, wanted);
  const lineShapes = {};
  for (const routeId of METRO_ROUTE_IDS) {
    lineShapes[routeId.toLowerCase()] = pickAlignments(shapeIdsByRoute.get(routeId), shapes);
  }
  return { stations, lineShapes };
}

function buildRail(rail) {
  const stops = new Map(csvRows(rail, 'stops.txt').map((r) => [r.stop_id, r]));
  const routes = csvRows(rail, 'routes.txt');
  const routeStops = csvRows(rail, 'route_stops.txt');
  const trips = csvRows(rail, 'trips.txt');

  const railStations = {};
  const wanted = new Set();
  const shapeIdsByRoute = new Map();
  for (const route of routes) {
    const key = route.route_id.toLowerCase();
    let ordered = routeStops
      .filter((r) => r.route_id === route.route_id && r.direction_id === '0')
      .sort((a, b) => Number(a.route_stop_sort_order) - Number(b.route_stop_sort_order))
      .map((r) => stops.get(r.stop_id))
      .filter(Boolean);
    if (ordered.length && RAIL_CENTER_CITY.has(ordered[0].stop_name)) ordered = ordered.reverse();
    railStations[key] = ordered.map((s) => ({
      id: s.stop_id,
      name: s.stop_name,
      lat: round5(Number(s.stop_lat)),
      lon: round5(Number(s.stop_lon)),
    }));
    // Regional Rail shapes run both directions as distinct ids; take all.
    const usage = new Map();
    for (const t of trips) {
      if (t.route_id !== route.route_id || !t.shape_id) continue;
      usage.set(t.shape_id, (usage.get(t.shape_id) || 0) + 1);
    }
    const ids = [...usage.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    shapeIdsByRoute.set(key, ids);
    for (const id of ids) wanted.add(id);
  }
  const shapes = loadShapes(rail, wanted);
  const railLineShapes = {};
  for (const [key, ids] of shapeIdsByRoute) {
    railLineShapes[key] = pickAlignments(ids, shapes, 2);
  }
  return { railStations, railLineShapes };
}

const busRouteKey = (name) => String(name).trim().replace(/\s+/g, '-');

function buildBusRoutes(bus) {
  const routes = csvRows(bus, 'routes.txt')
    .filter((r) => r.route_type === '3' || r.route_type === '11')
    .sort((a, b) => Number(a.route_sort_order) - Number(b.route_sort_order));
  const out = {};
  // Keys hyphenate SEPTA's spaced route names ('L1 OWL' → 'L1-OWL') so they
  // work unescaped in URLs and feed filenames.
  for (const r of routes) out[busRouteKey(r.route_short_name || r.route_id)] = r.route_long_name;
  return out;
}

const writeJson = (file, data) => {
  const dest = resolve(OUT_DIR, file);
  writeFileSync(dest, `${JSON.stringify(data)}\n`);
  console.log(`build-reference-data: wrote ${dest}`);
};

const outer = readZip(await loadOuterZip(process.argv[2]));
const bus = readZip(outer.read('google_bus.zip'));
const rail = readZip(outer.read('google_rail.zip'));

const metro = buildMetro(bus);
writeJson('metroStations.json', metro.stations);
writeJson('metroLineShapes.json', metro.lineShapes);
const railData = buildRail(rail);
writeJson('railStations.json', railData.railStations);
writeJson('railLineShapes.json', railData.railLineShapes);
writeJson('busRoutes.json', buildBusRoutes(bus));
