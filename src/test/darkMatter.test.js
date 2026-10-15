import { describe, expect, it } from 'vitest';
import { styleTally, tintTile } from '../lib/darkMatter.js';

// The page's side of the tint (the colours themselves are tested with the
// bots', bot/test/basemap.test.js): RGBA in, RGBA out, and a running judgement
// of CARTO's style over the tiles a page has drawn.

const S = 32;
const rgba = (paint) => {
  const px = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < S * S; i++) px.set(paint(i % S, Math.floor(i / S)), i * 4);
  return px;
};
const LAND = [0x0e, 0x0e, 0x0e, 255];
const STREET = [0x41, 0x47, 0x58, 255];
const NONE = [0, 0, 0, 0];
const at = (px, x, y) => [...px.slice((y * S + x) * 4, (y * S + x) * 4 + 4)];

describe('tintTile', () => {
  const base = rgba((x) => (x < 16 ? LAND : STREET));
  const labels = rgba((_, y) => (y === 5 ? [0x3c, 0x3c, 0x3c, 204] : NONE));

  it("tints the map and its labels to Dark Matter's", () => {
    const out = tintTile(base, labels, S, S, 15, { base: true, labels: true });
    expect(at(out, 4, 20)).toEqual([0x09, 0x09, 0x09, 255]);
    expect(at(out, 28, 20)).toEqual([0x19, 0x19, 0x19, 255]);
    // A place name's halo, #191919 at 80% over the land.
    const halo = Math.round(0x09 * 0.2 + 0x19 * 0.8);
    expect(at(out, 4, 5)).toEqual([halo, halo, halo, 255]);
  });

  it('leaves either layer as CARTO drew it when told to', () => {
    const out = tintTile(base, labels, S, S, 15, { base: false, labels: false });
    expect(at(out, 28, 20)).toEqual(STREET);
    const halo = Math.round(0x0e * 0.2 + 0x3c * 0.8);
    expect(at(out, 4, 5)).toEqual([halo, halo, halo, 255]);
  });
});

describe('styleTally', () => {
  const shares = (bk, lk) => ({
    base: { known: bk, total: 100 },
    labels: { known: lk, total: 1000 },
  });

  it('says nothing while the style is the one it tints', () => {
    const tally = styleTally();
    expect(tally.add(shares(80, 900))).toEqual({
      style: expect.objectContaining({ base: true, labels: true }),
      said: null,
    });
  });

  it('says once when the style has changed, and again when it is back', () => {
    const tally = styleTally();
    const first = tally.add(shares(0, 0));
    expect(first.style).toMatchObject({ base: false, labels: false });
    expect(first.said).toMatch(/^CARTO's style has changed/);
    expect(tally.add(shares(0, 0)).said).toBeNull();
    // It judges every tile so far, so it takes enough good ones to come back.
    expect(tally.add(shares(100, 1000)).said).toBeNull();
    let back = null;
    for (let i = 0; i < 5 && !back; i++) back = tally.add(shares(100, 1000)).said;
    expect(back).toBe('tinted to Dark Matter');
  });

  it('hands over what it has added up, for a worker to judge a tile with', () => {
    const tally = styleTally();
    tally.add(shares(80, 900));
    tally.add(shares(60, 700));
    const sum = tally.sum();
    expect(sum).toEqual({ base: { known: 140, total: 200 }, labels: { known: 1600, total: 2000 } });
    // A copy: adding more later does not change it.
    tally.add(shares(0, 0));
    expect(sum.base.known).toBe(140);
  });
});
