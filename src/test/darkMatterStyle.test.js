import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { darkMatterStyle, tintColour } from '../lib/darkMatterStyle.js';

// The site's vector style: CARTO's dark-matter style in the bots' tint colours.
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const carto = read('../../scripts/carto-dark-matter-style.json');
const site = read('../../public/maps/dark-matter.json');
const layer = (style, id) => style.layers.find((l) => l.id === id);

describe('tintColour', () => {
  it("gives CARTO's flat colours the tint's", () => {
    expect(tintColour('#0e0e0e')).toBe('#090909'); // land
    expect(tintColour('#2C353C')).toBe('#262626'); // water
    expect(tintColour('rgba(65, 71, 88, 1)')).toBe('#191919'); // streets
    expect(tintColour('rgba(83, 86, 102, 1)')).toBe('#030303'); // main roads
    expect(tintColour('rgba(73, 73, 73, 1)')).toBe('#030303'); // motorways
  });

  it('darkens other greys by five, keeping their opacity', () => {
    expect(tintColour('#262626')).toBe('#212121');
    expect(tintColour('#0b0b0b')).toBe('#060606');
    expect(tintColour('rgba(0, 0, 0, 0.4)')).toBe('rgba(0, 0, 0, 0.4)');
    expect(tintColour('rgba(34, 34, 34, 0.5)')).toBe('rgba(29, 29, 29, 0.5)');
  });

  it('leaves alone what it has no rule for', () => {
    expect(tintColour('transparent')).toBe('transparent');
    expect(tintColour('rgba(63, 90, 109, 1)')).toBe('rgba(63, 90, 109, 1)');
  });
});

describe('darkMatterStyle', () => {
  const style = darkMatterStyle(carto);

  it('is what public/maps/dark-matter.json holds (run `npm run map-style` if not)', () => {
    expect(site).toEqual(JSON.parse(JSON.stringify(style)));
  });

  it("keeps CARTO's layers, sources, fonts and icons, and leaves its input alone", () => {
    expect(style.layers.map((l) => l.id)).toEqual(carto.layers.map((l) => l.id));
    expect(style.sources).toEqual(carto.sources);
    expect(style.glyphs).toBe(carto.glyphs);
    expect(style.sprite).toBe(carto.sprite);
    expect(layer(carto, 'background').paint['background-color']).toBe('#0e0e0e');
  });

  it('paints land, water, streets, roads and buildings as the tint does', () => {
    expect(layer(style, 'background').paint['background-color']).toBe('#090909');
    expect(layer(style, 'water').paint['fill-color']).toBe('#262626');
    expect(layer(style, 'road_minor_fill').paint['line-color']).toBe('#191919');
    expect(layer(style, 'road_pri_fill_noramp').paint['line-color']).toBe('#030303');
    expect(layer(style, 'road_mot_fill_noramp').paint['line-color']).toBe('#030303');
    expect(layer(style, 'road_pri_case_noramp').paint['line-color']).toBe('#2a2a2a');
    expect(layer(style, 'building-top').paint).toMatchObject({
      'fill-color': '#000000',
      'fill-outline-color': '#111111',
    });
    // Nothing of CARTO's blue-grey is left.
    const colours = JSON.stringify(style.layers.map((l) => l.paint));
    for (const blue of ['65, 71, 88', '83, 86, 102', '#2C353C', '63, 90, 109', '103, 103, 114']) {
      expect(colours).not.toContain(blue);
    }
  });

  it('labels roads #333 and every other name #393939, in lighter type for places', () => {
    expect(layer(style, 'roadname_pri').paint).toMatchObject({
      'text-color': '#333333',
      'text-halo-color': 'rgba(3, 3, 3, 0.8)',
    });
    expect(layer(style, 'place_city_r5').paint).toMatchObject({
      'text-color': '#393939',
      'text-halo-color': 'rgba(25, 25, 25, 0.8)',
    });
    expect(layer(style, 'place_town').layout['text-font'][0]).toBe('Montserrat Regular');
    expect(layer(carto, 'place_town').layout['text-font'][0]).toBe('Montserrat Medium');
    // Water names stay italic.
    expect(layer(style, 'waterway_label').layout['text-font'][0]).toBe('Montserrat Regular Italic');
  });

  it('moves every zoom down one, for MapLibre’s 512-px tiles', () => {
    expect(layer(style, 'road_minor_fill').minzoom).toBe(
      layer(carto, 'road_minor_fill').minzoom - 1,
    );
    expect(layer(style, 'roadname_pri').layout['text-size'].stops[0][0]).toBe(
      layer(carto, 'roadname_pri').layout['text-size'].stops[0][0] - 1,
    );
    // A name's size is scaled, a road name's is not.
    const town = (s) => layer(s, 'place_town').layout['text-size'].stops[0][1];
    expect(town(style)).toBeCloseTo(town(carto) * 0.975, 6);
    expect(layer(style, 'roadname_minor').layout['text-size']).toBe(9);
  });
});
