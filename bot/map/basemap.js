// Street basemaps from Mapbox's Static Images API — only the basemap: every
// line, marker, and label is drawn on top as SVG (see draw.js), which keeps
// URLs short and the styling ours. Without a token (tests, local dry runs)
// a plain dark background stands in so rendering still works end to end.
import sharp from 'sharp';

export const MAPBOX_STYLE = 'mapbox/dark-v11';
export const PLACEHOLDER_BG = '#1d2126';

export function staticMapUrl(view, token, { style = MAPBOX_STYLE } = {}) {
  const lon = view.lon.toFixed(5);
  const lat = view.lat.toFixed(5);
  return (
    `https://api.mapbox.com/styles/v1/${style}/static/${lon},${lat},${view.zoom}` +
    `/${view.width}x${view.height}@2x?access_token=${encodeURIComponent(token)}`
  );
}

/**
 * @param {{ token?: string | null, fetchFn?: typeof fetch, log?: (m: string) => void }} opts
 * @returns {(view: {lat:number, lon:number, zoom:number, width:number, height:number}) => Promise<Buffer>}
 *   PNG/JPEG at the view's logical size
 */
export function createBasemap({ token = null, fetchFn = fetch, log = () => {} } = {}) {
  return async function basemap(view) {
    if (!token) {
      return sharp({
        create: { width: view.width, height: view.height, channels: 3, background: PLACEHOLDER_BG },
      })
        .png()
        .toBuffer();
    }
    const url = staticMapUrl(view, token);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`Mapbox HTTP ${res.status}`);
        const raw = Buffer.from(await res.arrayBuffer());
        // @2x tiles come back at double size; draw in logical pixels.
        return sharp(raw).resize(view.width, view.height).png().toBuffer();
      } catch (err) {
        lastErr = err;
        log(`basemap: ${err.message}${attempt === 0 ? ' — retrying' : ''}`);
        await new Promise((r) => setTimeout(r, 750));
      }
    }
    throw lastErr;
  };
}
