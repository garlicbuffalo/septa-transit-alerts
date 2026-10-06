import { describe, expect, it } from 'vitest';
import { describeText } from '../components/event/incidentText.jsx';
import { computeDisruptionMinutes } from '../lib/aggregate.js';
import {
  formatEvidenceChip,
  incidentCategory,
  isTripCancellations,
  summarizeSignals,
  vehicleWord,
} from '../lib/incidents.js';
import { incident } from './v2TestHelpers.js';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

// Detection evidence shapes the SEPTA collector publishes
// (collector/lib/vehicleDetectors.js, collector/lib/tripCancellations.js).
describe('collector detection evidence chips', () => {
  const rec = (kind, line, evidence) => ({ kind, line, evidence });

  it('summarizes gaps, bunching, missing vehicles, and held vehicles', () => {
    expect(
      formatEvidenceChip(rec('bus', '17', { kind: 'gap', gap_min: 35, headway_min: 10 })),
    ).toBe('~35 min gap · scheduled every ~10 min');
    expect(
      formatEvidenceChip(
        rec('metro', 't1', { kind: 'bunching', vehicle_count: 3, distance_m: 120 }),
      ),
    ).toBe('3 trolleys within 120 m');
    expect(formatEvidenceChip(rec('bus', '23', { kind: 'ghost', scheduled: 9, tracked: 3 }))).toBe(
      '3 of 9 scheduled on the tracker',
    );
    expect(
      formatEvidenceChip(
        rec('metro', 'g1', { kind: 'held', vehicle_count: 2, stationaryMs: 15 * 60 * 1000 }),
      ),
    ).toBe('2 trolleys held · 15 min stationary');
    expect(
      formatEvidenceChip(rec('bus', '23', { kind: 'held', busCount: 1, vehicle_count: 1 })),
    ).toBe('1 bus held');
    expect(
      formatEvidenceChip(rec('bus', '35', { kind: 'thin-gap', silent_min: 70, headway_min: 30 })),
    ).toBe('no buses on the tracker for ~70 min · scheduled every ~30 min');
  });

  it("summarizes a route's cancelled trips", () => {
    expect(
      formatEvidenceChip(
        rec('bus', '16', { kind: 'trip-cancellations', cancelled: 14, scheduled: 107 }),
      ),
    ).toBe('14 of 107 trips cancelled');
  });
});

describe('vehicle wording', () => {
  it('calls trolley-line vehicles trolleys', () => {
    expect(vehicleWord('bus', '17')).toBe('buses');
    expect(vehicleWord('metro', 't3')).toBe('trolleys');
    expect(vehicleWord('metro', 'm1')).toBe('trains');
    expect(summarizeSignals(['bunching'], 'metro', 'd2')).toBe('Bunched trolleys');
    expect(summarizeSignals(['trip-cancellations'], 'bus')).toBe('Cancelled bus trips');
  });
});

describe('trip-cancellation incidents', () => {
  const cancels = incident({
    id: 'trip-cancellations-2026-10-06-16',
    kind: 'bus',
    routes: ['16'],
    first_seen_ts: NOW - 6 * HOUR,
    active: true,
    cta: null,
    observations: [
      {
        detection_source: 'trip-cancellations',
        line: '16',
        ts: NOW - 6 * HOUR,
        active: true,
        bot_description: '14 Route 16 trips cancelled — 4:41 AM, 5:08 AM, 5:34 AM, and 11 more',
      },
    ],
  });

  it('sit with routine delays on the homepage', () => {
    expect(isTripCancellations(cancels)).toBe(true);
    expect(incidentCategory(cancels, NOW)).toBe('delay');
  });

  it('are titled with the collector sentence', () => {
    expect(describeText(cancels)).toBe(
      '14 Route 16 trips cancelled — 4:41 AM, 5:08 AM, 5:34 AM, and 11 more',
    );
  });

  it("don't count toward disrupted time", () => {
    const obs = {
      kind: 'bus',
      line: '16',
      detection_source: 'trip-cancellations',
      ts: NOW - 6 * HOUR,
      resolved_ts: null,
      active: true,
      _incidentId: cancels.id,
    };
    const out = computeDisruptionMinutes([], [obs], {
      now: NOW,
      lines: [{ kind: 'bus', line: '16' }],
    });
    expect(out.disruptedMinutes).toBe(0);
  });
});
