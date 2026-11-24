import { describe, expect, it } from 'vitest';
import { findCandidateCorridors } from '../../src/routing/corridors.js';
import { findJourneysFromCorridors, removeDominated } from '../../src/routing/router.js';
import type { Journey, Line, LineStop, NetworkTopology, Stop } from '../../src/types.js';

function makeStop(code: string, lat = 37.38, lon = -5.98): Stop {
  return { code, name: `Stop ${code}`, lat, lon, lines: [] };
}

function makeLineStop(code: string, dist: number, startTime: string, lat = 37.38, lon = -5.98): LineStop {
  return {
    code,
    name: `Stop ${code}`,
    lat,
    lon,
    distanceMeters: dist,
    startTime,
    endTime: '23:00',
    icons: [],
  };
}

function makeLine(id: number, label: string, isCircular = false): Line {
  return {
    id,
    label,
    subline: null,
    description: `Line ${label}`,
    color: '#000000',
    isCircular,
    directions: [{ direction: isCircular ? 99 : 1, destination: 'DEST', startTime: '06:00', endTime: '23:00' }],
  };
}

function buildTopology(
  stops: Stop[],
  routes: Array<{ line: Line; stops: LineStop[] }>,
): NetworkTopology {
  const linesRec: Record<string, Line> = {};
  const stopsRec: Record<string, Stop> = {};
  const lineStopsRec: Record<string, LineStop[]> = {};

  for (const s of stops) {
    stopsRec[s.code] = s;
  }
  for (const r of routes) {
    linesRec[String(r.line.id)] = r.line;
    const dir = r.line.isCircular ? 99 : 1;
    lineStopsRec[`${r.line.id}:${dir}`] = r.stops;
  }

  return {
    schemaVersion: 1,
    syncedAt: '2026-11-24T12:00:00.000Z',
    includesNight: false,
    lines: linesRec,
    stops: stopsRec,
    lineStops: lineStopsRec,
  };
}

describe('TUSSAM Router (mirrors renfe-cli router guarantees)', () => {
  it('finds a three-transfer journey when maxTransfers is 3', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('1'), makeStop('2'), makeStop('3'), makeStop('X')],
      [
        { line: makeLine(1, 'L1'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('1', 600, '08:02')] },
        { line: makeLine(2, 'L2'), stops: [makeLineStop('1', 0, '08:06'), makeLineStop('2', 600, '08:08')] },
        { line: makeLine(3, 'L3'), stops: [makeLineStop('2', 0, '08:12'), makeLineStop('3', 600, '08:14')] },
        { line: makeLine(4, 'L4'), stops: [makeLineStop('3', 0, '08:18'), makeLineStop('X', 600, '08:20')] },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 3, maxWalkMeters: 0 });
    expect(corridors).toHaveLength(1);

    const schedules: Record<string, number[]> = {
      '1:O': [8 * 3600],
      '1:1': [8 * 3600 + 120],
      '2:1': [8 * 3600 + 360],
      '2:2': [8 * 3600 + 480],
      '3:2': [8 * 3600 + 720],
      '3:3': [8 * 3600 + 840],
      '4:3': [8 * 3600 + 1080],
      '4:X': [8 * 3600 + 1200],
    };

    const journeys = findJourneysFromCorridors(
      topo,
      corridors,
      (lineId, stopCode) => schedules[`${lineId}:${stopCode}`] ?? [],
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.transferCount).toBe(3);
  });

  it('does not return routes exceeding maxTransfers', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('1'), makeStop('2'), makeStop('3'), makeStop('4'), makeStop('X')],
      [
        { line: makeLine(1, 'L1'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('1', 500, '08:02')] },
        { line: makeLine(2, 'L2'), stops: [makeLineStop('1', 0, '08:06'), makeLineStop('2', 500, '08:08')] },
        { line: makeLine(3, 'L3'), stops: [makeLineStop('2', 0, '08:12'), makeLineStop('3', 500, '08:14')] },
        { line: makeLine(4, 'L4'), stops: [makeLineStop('3', 0, '08:18'), makeLineStop('4', 500, '08:20')] },
        { line: makeLine(5, 'L5'), stops: [makeLineStop('4', 0, '08:24'), makeLineStop('X', 500, '08:26')] },
      ],
    );

    expect(findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 3, maxWalkMeters: 0 })).toEqual([]);
  });

  it('requires sufficient buffer time to make a same-stop transfer', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('1'), makeStop('X')],
      [
        { line: makeLine(1, 'L1'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('1', 600, '08:03')] },
        { line: makeLine(2, 'L2'), stops: [makeLineStop('1', 0, '08:04'), makeLineStop('X', 600, '08:08')] },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 1, maxWalkMeters: 0 });
    const schedules: Record<string, number[]> = {
      '1:O': [8 * 3600],
      '1:1': [8 * 3600 + 180], // 08:03:00
      // 08:03:30 is too soon (<120s buffer), 08:06:00 is feasible
      '2:1': [8 * 3600 + 210, 8 * 3600 + 360],
      '2:X': [8 * 3600 + 450, 8 * 3600 + 600],
    };

    const journeys = findJourneysFromCorridors(
      topo,
      corridors,
      (lineId, stopCode) => schedules[`${lineId}:${stopCode}`] ?? [],
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.legs[1]?.departureSeconds).toBe(8 * 3600 + 360);
  });

  it('supports nearby walking transfers within maxWalkMeters', () => {
    // Stops A and B are ~111m apart
    const topo = buildTopology(
      [makeStop('O', 37.38, -5.98), makeStop('A', 37.385, -5.98), makeStop('B', 37.386, -5.98), makeStop('X', 37.39, -5.98)],
      [
        { line: makeLine(1, '01'), stops: [makeLineStop('O', 0, '08:00', 37.38, -5.98), makeLineStop('A', 600, '08:04', 37.385, -5.98)] },
        { line: makeLine(2, '37'), stops: [makeLineStop('B', 0, '08:10', 37.386, -5.98), makeLineStop('X', 600, '08:14', 37.39, -5.98)] },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 1, maxWalkMeters: 300 });
    expect(corridors).toHaveLength(1);
    expect(corridors[0]?.transfers[0]?.walkMeters).toBeGreaterThan(90);
    expect(corridors[0]?.transfers[0]?.walkMeters).toBeLessThan(150);

    const schedules: Record<string, number[]> = {
      '1:O': [8 * 3600],
      '1:A': [8 * 3600 + 240],
      '2:B': [8 * 3600 + 600],
      '2:X': [8 * 3600 + 840],
    };

    const journeys = findJourneysFromCorridors(
      topo,
      corridors,
      (lineId, stopCode) => schedules[`${lineId}:${stopCode}`] ?? [],
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.transfers[0]?.walkMeters).toBeGreaterThan(90);
  });

  it('penalizes a transfer that saves too little time vs direct bus', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('M'), makeStop('X')],
      [
        { line: makeLine(1, 'Direct'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('X', 4000, '08:18')] },
        { line: makeLine(2, 'Fast1'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('M', 2000, '08:06')] },
        { line: makeLine(3, 'Fast2'), stops: [makeLineStop('M', 0, '08:09'), makeLineStop('X', 2000, '08:16')] },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 1, maxWalkMeters: 0 });
    const schedules: Record<string, number[]> = {
      '1:O': [8 * 3600],
      '1:X': [8 * 3600 + 18 * 60],
      '2:O': [8 * 3600],
      '2:M': [8 * 3600 + 6 * 60],
      '3:M': [8 * 3600 + 9 * 60],
      '3:X': [8 * 3600 + 16 * 60],
    };

    const journeys = findJourneysFromCorridors(
      topo,
      corridors,
      (lineId, stopCode) => schedules[`${lineId}:${stopCode}`] ?? [],
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.legs[0]?.lineLabel).toBe('Direct');
    expect(journeys[0]?.transferCount).toBe(0);
  });

  it('routes across index 0 on circular lines (sentido 99)', () => {
    const topo = buildTopology(
      [makeStop('S0'), makeStop('S1'), makeStop('S2'), makeStop('S3')],
      [
        {
          line: makeLine(81, 'C1', true),
          stops: [
            makeLineStop('S0', 0, '08:00'),
            makeLineStop('S1', 500, '08:02'),
            makeLineStop('S2', 1000, '08:04'),
            makeLineStop('S3', 1500, '08:06'),
          ],
        },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'S3', 'S1', { maxTransfers: 0, maxWalkMeters: 0 });
    expect(corridors).toHaveLength(1);
    expect(corridors[0]?.legs[0]?.stopsCount).toBe(2);

    const journeys = findJourneysFromCorridors(
      topo,
      corridors,
      (_lineId, stopCode) => (stopCode === 'S3' ? [8 * 3600 + 360] : [8 * 3600 + 600]),
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.legs[0]?.fromStopCode).toBe('S3');
    expect(journeys[0]?.legs[0]?.toStopCode).toBe('S1');
  });

  it('prunes Pareto-dominated journeys cleanly', () => {
    const baseLeg = {
      lineId: 1,
      lineLabel: '01',
      lineColor: '#f54129',
      direction: 1,
      fromStopCode: 'O',
      fromStopName: 'Origin',
      toStopCode: 'X',
      toStopName: 'Dest',
      stopsCount: 4,
      estimated: false,
    };

    const slowEarlier: Journey = {
      legs: [{ ...baseLeg, departureSeconds: 8 * 3600, arrivalSeconds: 8 * 3600 + 1800 }],
      transfers: [],
      departureSeconds: 8 * 3600,
      arrivalSeconds: 8 * 3600 + 1800,
      durationSeconds: 1800,
      transferCount: 0,
      estimated: false,
    };
    const fastLater: Journey = {
      legs: [{ ...baseLeg, departureSeconds: 8 * 3600 + 300, arrivalSeconds: 8 * 3600 + 1500 }],
      transfers: [],
      departureSeconds: 8 * 3600 + 300,
      arrivalSeconds: 8 * 3600 + 1500,
      durationSeconds: 1200,
      transferCount: 0,
      estimated: false,
    };

    const result = removeDominated([slowEarlier, fastLater]);
    expect(result).toEqual([fastLater]);
  });

  it('excludes night lines unless includeNight is true', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('X')],
      [
        { line: makeLine(101, 'A1'), stops: [makeLineStop('O', 0, '01:00'), makeLineStop('X', 2000, '01:08')] },
      ],
    );

    expect(findCandidateCorridors(topo, 'O', 'X', { includeNight: false })).toEqual([]);
    const nightCorridors = findCandidateCorridors(topo, 'O', 'X', { includeNight: true });
    expect(nightCorridors).toHaveLength(1);
    expect(nightCorridors[0]?.legs[0]?.lineLabel).toBe('A1');
  });

  it('caps transfer corridors at 2 when a direct corridor exists', () => {
    const topo = buildTopology(
      [makeStop('O'), makeStop('M1'), makeStop('M2'), makeStop('M3'), makeStop('X')],
      [
        { line: makeLine(1, 'Direct'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('X', 4000, '08:25')] },
        { line: makeLine(2, 'R1a'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('M1', 1000, '08:04')] },
        { line: makeLine(3, 'R1b'), stops: [makeLineStop('M1', 0, '08:07'), makeLineStop('X', 1000, '08:11')] },
        { line: makeLine(4, 'R2a'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('M2', 1200, '08:05')] },
        { line: makeLine(5, 'R2b'), stops: [makeLineStop('M2', 0, '08:08'), makeLineStop('X', 1200, '08:13')] },
        { line: makeLine(6, 'R3a'), stops: [makeLineStop('O', 0, '08:00'), makeLineStop('M3', 1400, '08:06')] },
        { line: makeLine(7, 'R3b'), stops: [makeLineStop('M3', 0, '08:09'), makeLineStop('X', 1400, '08:15')] },
      ],
    );

    const corridors = findCandidateCorridors(topo, 'O', 'X', { maxTransfers: 1, maxWalkMeters: 0 });
    const directCount = corridors.filter((c) => c.transfers.length === 0).length;
    const transferCount = corridors.filter((c) => c.transfers.length > 0).length;
    expect(directCount).toBe(1);
    expect(transferCount).toBeLessThanOrEqual(2);
  });
});
