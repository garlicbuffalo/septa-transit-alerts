import { describe, expect, it } from 'vitest';
import {
  normalizeRailLine,
  RAIL_LINE_ORDER,
  RAIL_LINES,
  railLineFullName,
  railLineInfo,
} from '../lib/railLines.js';

describe('railLines', () => {
  it('has all 13 Regional Rail lines with hex colors and codes', () => {
    expect(RAIL_LINE_ORDER).toHaveLength(13);
    for (const k of RAIL_LINE_ORDER) {
      expect(RAIL_LINES[k].label).toBeTruthy();
      expect(RAIL_LINES[k].code).toBe(k.toUpperCase());
      expect(RAIL_LINES[k].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(RAIL_LINES[k].chartColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it('normalizes route codes (PAO -> pao) and resolves info either case', () => {
    expect(normalizeRailLine('PAO')).toBe('pao');
    expect(railLineInfo('PAO').label).toBe('Paoli/Thorndale');
    expect(railLineInfo('wtr').label).toBe('West Trenton');
    expect(railLineFullName('pao')).toBe('Paoli/Thorndale Line');
    expect(normalizeRailLine(null)).toBe(null);
  });
});
