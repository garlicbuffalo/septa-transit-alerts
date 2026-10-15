// The site's map tiles, tinted back to Dark Matter off the main thread (see
// darkMatterTiles.js). Asked for a tile's map and labels layers by address, it
// fetches both, tints them (darkMatter.js) and answers with a PNG and how well
// the tile fits the style the tint was made for. Whether to tint is judged
// with `sum`, what the page's tiles so far added up to.
import { judgeStyle, labelFit, styleFit, tintTile } from './darkMatter.js';

// A tile's pixels, RGBA. A failure here is the tile's, not the tint's.
async function pixels(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    throw Object.assign(new Error(err.message), { kind: 'fetch' });
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) {
    throw Object.assign(new Error(`HTTP ${res.status} ${type}`), { kind: 'fetch' });
  }
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = async ({ data: { id, base, labels, z, sum } }) => {
  try {
    const [b, l] = await Promise.all([pixels(base), pixels(labels)]);
    const { width, height } = b;
    if (l.width !== width || l.height !== height) {
      throw Object.assign(new Error(`labels ${l.width} px, map ${width} px`), { kind: 'fetch' });
    }
    const fit = {
      base: styleFit(b.data, width, height, 4, z),
      labels: labelFit(l.data, width, height),
    };
    const style = judgeStyle([sum, fit]);
    const rgba = tintTile(b.data, l.data, width, height, z, style);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, blob, fit });
  } catch (err) {
    self.postMessage({ id, error: err.message, kind: err.kind ?? 'tint' });
  }
};
