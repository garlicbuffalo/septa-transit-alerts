import { describe, expect, it } from 'vitest';
import { normalizeRailLine, RAIL_LINE_ORDER, RAIL_LINES, railLineInfo } from '../lib/railLines.js';

describe('railLines', () => {
  it('has all 11 lines with hex colors', () => {
    expect(RAIL_LINE_ORDER).toHaveLength(11);
    for (const k of RAIL_LINE_ORDER) {
      expect(RAIL_LINES[k].label).toBeTruthy();
      expect(RAIL_LINES[k].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it('normalizes raw route_ids (UP-W -> up-w) and resolves info either case', () => {
    expect(normalizeRailLine('UP-W')).toBe('up-w');
    expect(railLineInfo('UP-W').label).toBe('Union Pacific West');
    expect(railLineInfo('bnsf').label).toBe('BNSF');
    expect(normalizeRailLine(null)).toBe(null);
  });
});
