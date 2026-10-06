// GTFS file access shared by the collector (collector/lib/schedule.js) and the
// reference-data build (scripts/build-reference-data.js): a minimal zip reader
// and a CSV parser for SEPTA's GTFS bundle. No dependencies.
import { inflateRawSync } from 'node:zlib';

// SEPTA publishes one outer zip holding two inner GTFS feeds:
//   google_bus.zip  — buses, trackless trolleys, and SEPTA Metro (L/B/M/T/G/D)
//   google_rail.zip — Regional Rail
export const GTFS_URL = 'https://www3.septa.org/developer/gtfs_public.zip';

// --- Minimal zip reader -------------------------------------------------------
// Reads the central directory and inflates individual entries. Enough for GTFS
// (stored or deflated entries, no zip64, no encryption).
export function readZip(buf) {
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
export function eachCsvRow(text, onRow) {
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

export function parseCsvLine(line) {
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

export function csvRows(zip, name) {
  const rows = [];
  eachCsvRow(zip.read(name).toString('utf8'), (r) => rows.push(r));
  return rows;
}
