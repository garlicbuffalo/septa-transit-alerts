import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  activeSource,
  layerUrls,
  noteTileFailed,
  noteTileLoaded,
  noteTintFailed,
  subscribeSource,
  tileUrl,
} from '../lib/basemap.js';
import { tintedTile } from '../lib/darkMatterTiles.js';

// Station labels drawn over a map's dark tiles: light text with a dark halo
// (the page's own white-halo labels would vanish on them).
export const LABEL_ON_MAP = 'text-slate-100 [text-shadow:0_0_3px_#000,0_0_3px_#000,0_0_4px_#000]';

// The basemap behind a line map's SVG. Both go in the same `relative`
// container, the SVG after this so it draws on top; the container sets the
// size, and the tiles are placed in % of it, so they stay under the same
// stations at any width. Tiles are plain <img>s (not SVG <image>) so the CSS
// filter that darkens OpenStreetMap's work in every browser.
//
// `basemap` is what buildLineMap & co. return when asked for one
// ({ z, tiles }); with none this draws nothing.
export function BasemapTiles({ basemap }) {
  const source = useSyncExternalStore(subscribeSource, activeSource, activeSource);
  if (!basemap) return null;
  const retina = (globalThis.devicePixelRatio ?? 1) > 1;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] bg-[#262626]"
    >
      <div
        className="absolute inset-0"
        style={source.filter ? { filter: source.filter } : undefined}
      >
        {basemap.tiles.map((t) => (
          <TileImage
            key={`${source.id}/${basemap.z}/${t.x}/${t.y}`}
            source={source}
            tile={t}
            z={basemap.z}
            retina={retina}
          />
        ))}
      </div>
    </div>
  );
}

// One tile: CARTO's as it comes, or (a source with `layers`) tinted back to
// Dark Matter, which takes a moment in the tile worker before there is
// anything to show.
function TileImage({ source, tile, z, retina }) {
  const tinted = Boolean(source.layers);
  const [src, setSrc] = useState(tinted ? null : tileUrl(source, tile, z, retina));
  useEffect(() => {
    if (!tinted) return;
    let live = true;
    tintedTile(layerUrls(source, tile, z), z).then(
      (url) => live && setSrc(url),
      (err) => {
        if (!live) return;
        if (err.kind === 'tint') noteTintFailed();
        else noteTileFailed(source);
      },
    );
    return () => {
      live = false;
    };
  }, [tinted, source, tile, z]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onLoad={noteTileLoaded}
      onError={() => noteTileFailed(source)}
      className="absolute max-w-none select-none"
      style={{
        left: `${tile.left}%`,
        top: `${tile.top}%`,
        width: `${tile.w}%`,
        height: `${tile.h}%`,
      }}
    />
  );
}

// The tiles' credit (their licences ask for it): the line under a map.
export function SourceCredit() {
  const source = useSyncExternalStore(subscribeSource, activeSource, activeSource);
  return (
    <p className="mt-1.5 text-right text-[10px] leading-tight text-slate-400 dark:text-slate-500">
      {source.credits.map((c, i) => (
        <span key={c.href}>
          {i > 0 && ' '}
          <a href={c.href} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {c.label}
          </a>
        </span>
      ))}
    </p>
  );
}

// The same under a line map's tiles, which are only drawn when it has some:
// it sits outside the map's scroller, so on a phone it stays in view instead of
// at the far edge of a map wider than the screen.
export function BasemapCredit({ basemap }) {
  if (!basemap) return null;
  return <SourceCredit />;
}
