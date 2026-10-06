// Web Mercator math matching Mapbox's Static Images API (512-px tiles), so
// SVG drawn over a fetched basemap lands exactly on the streets beneath it.

export const TILE_SIZE = 512;

const toRad = (d) => (d * Math.PI) / 180;

/** World pixel coordinates at zoom 0 (a 512×512 world). */
export function worldPx(lat, lon) {
  const x = ((lon + 180) / 360) * TILE_SIZE;
  const s = Math.sin(toRad(Math.max(-85.0511, Math.min(85.0511, lat))));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE;
  return { x, y };
}

/** Bounding box of [lat, lon] points (or {lat, lon}). */
export function bboxOf(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lon = Array.isArray(p) ? p[1] : p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * The view that fits a bbox in a width×height image with `pad` px of margin:
 * center and zoom (two decimals, as Mapbox rounds), clamped to [minZoom, maxZoom].
 */
export function fitView(bbox, width, height, { pad = 80, minZoom = 9, maxZoom = 16 } = {}) {
  const a = worldPx(bbox.maxLat, bbox.minLon);
  const b = worldPx(bbox.minLat, bbox.maxLon);
  const dx = Math.max(1e-9, b.x - a.x);
  const dy = Math.max(1e-9, b.y - a.y);
  const zoom = Math.log2(Math.min((width - 2 * pad) / dx, (height - 2 * pad) / dy));
  const z = Math.round(Math.min(maxZoom, Math.max(minZoom, zoom)) * 100) / 100;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const lon = (cx / TILE_SIZE) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * cy) / TILE_SIZE;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon, zoom: z, width, height };
}

/** Image pixel position of a coordinate in a view. */
export function project(view, lat, lon) {
  const scale = 2 ** view.zoom;
  const c = worldPx(view.lat, view.lon);
  const p = worldPx(lat, lon);
  return {
    x: view.width / 2 + (p.x - c.x) * scale,
    y: view.height / 2 + (p.y - c.y) * scale,
  };
}

/** Meters per image pixel at the view's center. */
export function metersPerPx(view) {
  return (156543.03392 * Math.cos(toRad(view.lat))) / 2 ** view.zoom / 2;
}
