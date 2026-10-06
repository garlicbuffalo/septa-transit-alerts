// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyRoute, groupRoutesByMode, railKeyForTrainViewLine } from '../lib/network.js';
import { canonicalRailStation, findMetroStation, findStationScope } from '../lib/stations.js';
import { decodeEntities, htmlToText } from '../lib/text.js';
import {
  easternDateKey,
  easternMonthKey,
  isEndOfDayClock,
  isStartOfDayClock,
  parseEastern,
  parseServiceClock,
  serviceDateKey,
} from '../lib/time.js';

describe('time', () => {
  it('parses SEPTA local timestamps as Eastern time across DST', () => {
    // EDT (UTC-4) in October, EST (UTC-5) in January.
    expect(parseEastern('2026-10-05 14:40:00')).toBe(Date.UTC(2026, 9, 5, 18, 40));
    expect(parseEastern('2026-01-16 11:25:00.000')).toBe(Date.UTC(2026, 0, 16, 16, 25));
    expect(parseEastern(null)).toBeNull();
    expect(parseEastern('soon')).toBeNull();
  });

  it('buckets instants into Philadelphia days and months', () => {
    // 01:30 UTC on Nov 1 is still Oct 31 in Philadelphia.
    const ts = Date.UTC(2026, 10, 1, 1, 30);
    expect(easternDateKey(ts)).toBe('2026-10-31');
    expect(easternMonthKey(ts)).toBe('2026-10');
  });

  it('rolls post-midnight clock times onto the next calendar day', () => {
    expect(parseServiceClock('6:28 am', '2026-10-05')).toBe(Date.UTC(2026, 9, 5, 10, 28));
    expect(parseServiceClock('12:05 PM', '2026-10-05')).toBe(Date.UTC(2026, 9, 5, 16, 5));
    expect(parseServiceClock('1:15 am', '2026-10-05')).toBe(Date.UTC(2026, 9, 6, 5, 15));
    expect(parseServiceClock('na', '2026-10-05')).toBeNull();
    // 2 AM belongs to the previous service day.
    expect(serviceDateKey(Date.UTC(2026, 9, 6, 6, 0))).toBe('2026-10-05');
  });

  it('recognizes SEPTA whole-day sentinels', () => {
    expect(isStartOfDayClock('2026-10-10 00:01:00.000')).toBe(true);
    expect(isStartOfDayClock('2026-10-10 09:30:00.000')).toBe(false);
    expect(isEndOfDayClock('2026-12-19 23:59:00.000')).toBe(true);
  });
});

describe('text', () => {
  it('flattens Word-pasted HTML and decodes entities', () => {
    const html =
      '<p><span class="TextRun">Use 5th St&nbsp;instead.</span></p><ul><li>No access</li></ul>';
    expect(htmlToText(html)).toBe('Use 5th St instead.\n• No access');
    expect(decodeEntities('&ldquo;D&rdquo; &amp; &#39;M&#x27;')).toBe("“D” & 'M'");
  });
});

describe('network', () => {
  it('classifies Metro, Regional Rail, and bus route ids', () => {
    expect(classifyRoute('L1')).toEqual({ mode: 'metro', key: 'l1', known: true });
    expect(classifyRoute('PAO')).toEqual({ mode: 'regional_rail', key: 'pao', known: true });
    expect(classifyRoute('17')).toEqual({ mode: 'bus', key: '17', known: true });
    expect(classifyRoute('L1 OWL')).toEqual({ mode: 'bus', key: 'L1-OWL', known: true });
    expect(classifyRoute('LUCYGO')).toEqual({ mode: 'bus', key: 'LUCYGO', known: true });
    expect(classifyRoute('71-81').mode).toBe('bus');
    expect(classifyRoute('  ')).toBeNull();
  });

  it('groups a mixed route list by network, preserving first-seen order', () => {
    expect(groupRoutesByMode(['L1', 'L1 OWL', 'B3', '17', '17'])).toEqual([
      ['metro', ['l1', 'b3']],
      ['bus', ['L1-OWL', '17']],
    ]);
  });

  it('maps TrainView line names to Regional Rail keys', () => {
    expect(railKeyForTrainViewLine('Manayunk/Norristown')).toBe('nor');
    expect(railKeyForTrainViewLine('Media/Wawa')).toBe('med');
    expect(railKeyForTrainViewLine('Atlantis')).toBeNull();
  });
});

describe('stations', () => {
  it('finds a "between X and Y" stretch and fills it along the line', () => {
    const scope = findStationScope(
      'Shuttle Busing Conshohocken to Norristown - Elm St Stations',
      'regional_rail',
      ['nor'],
    );
    expect(scope.from_station).toBe('Conshohocken');
    expect(scope.to_station).toBe('Norristown Elm Street');
    expect(scope.stations).toEqual([
      'Conshohocken',
      'Norristown Transit Center',
      'Main St',
      'Norristown Elm Street',
    ]);
  });

  it('matches Metro stations by their everyday names', () => {
    const scope = findStationScope('Southbound Platform Boarding Bryn Mawr to Villanova', 'metro', [
      'm1',
    ]);
    expect(scope.from_station).toBe('Bryn Mawr South');
    expect(scope.to_station).toBe('Villanova South');
    expect(scope.stations).toContain('Stadium');
  });

  it('does not read a list of line names as station mentions', () => {
    const scope = findStationScope(
      'Paoli/Thorndale, Cynwyd, Trenton, Chestnut Hill West, Fox Chase and West Trenton trains may be delayed near 30th St',
      'regional_rail',
      ['pao', 'cyn', 'tre', 'chw', 'fox', 'wtr'],
    );
    expect(scope.mentioned_stations).toEqual(['Gray 30th St Station']);
    expect(scope.from_station).toBeNull();
  });

  it('only matches stations on the alert’s own lines', () => {
    const scope = findStationScope('Delays at Media', 'regional_rail', ['pao']);
    expect(scope.mentioned_stations).toEqual([]);
  });

  it('canonicalizes TrainView station spellings', () => {
    expect(canonicalRailStation('Fern Rock T C')).toBe('Fern Rock Transit Center');
    expect(canonicalRailStation('Gray 30th Street')).toBe('Gray 30th St Station');
    expect(canonicalRailStation('Temple U')).toBe('Temple University');
    expect(canonicalRailStation('Jenkintown Wyncote')).toBe('Jenkintown-Wyncote');
    expect(canonicalRailStation('Neshaminy')).toBe('Neshaminy Falls');
    expect(canonicalRailStation('Elm St')).toBe('Norristown Elm Street');
    expect(canonicalRailStation('')).toBeNull();
    expect(canonicalRailStation('Narnia')).toBe('Narnia');
  });

  it('resolves Metro station spellings from the elevator feed', () => {
    expect(findMetroStation('8th-Market').name).toBe('8th-Market');
    expect(findMetroStation('Norristown Transit Center').lines).toContain('m1');
  });
});
