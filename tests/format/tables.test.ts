import { describe, expect, it } from 'vitest';
import {
  formatAlerts,
  formatArrivalsTable,
  formatLinesTable,
  formatNearbyTable,
  formatTimetable,
} from '../../src/format/tables.js';
import type { Journey, Line, NearbyStop, ServiceAlert, StopArrivalsResult } from '../../src/types.js';

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('Table formatters', () => {
  it('renders TIMETABLE with direct and walking transfer rows', () => {
    const journeys: Journey[] = [
      {
        legs: [
          {
            lineId: 1,
            lineLabel: '01',
            lineColor: '#f54129',
            direction: 1,
            fromStopCode: '785',
            fromStopName: 'María Auxiliadora',
            toStopCode: '58',
            toStopName: 'Hospital V.Rocío',
            departureSeconds: 15 * 3600 + 50 * 60,
            arrivalSeconds: 16 * 3600 + 8 * 60,
            stopsCount: 10,
            estimated: false,
          },
        ],
        transfers: [],
        departureSeconds: 15 * 3600 + 50 * 60,
        arrivalSeconds: 16 * 3600 + 8 * 60,
        durationSeconds: 18 * 60,
        transferCount: 0,
        estimated: false,
      },
      {
        legs: [
          {
            lineId: 84,
            lineLabel: 'C4',
            lineColor: '#008431',
            direction: 99,
            fromStopCode: '43',
            fromStopName: 'Recaredo',
            toStopCode: '42',
            toStopName: 'Menéndez Pelayo',
            departureSeconds: 15 * 3600 + 54 * 60,
            arrivalSeconds: 16 * 3600 + 2 * 60,
            stopsCount: 2,
            estimated: false,
          },
          {
            lineId: 37,
            lineLabel: '37',
            lineColor: '#000d6f',
            direction: 1,
            fromStopCode: '80',
            fromStopName: 'Prado San Sebastián',
            toStopCode: '58',
            toStopName: 'Hospital V.Rocío',
            departureSeconds: 16 * 3600 + 9 * 60,
            arrivalSeconds: 16 * 3600 + 21 * 60,
            stopsCount: 6,
            estimated: true,
          },
        ],
        transfers: [
          {
            fromStopCode: '42',
            fromStopName: 'Menéndez Pelayo',
            toStopCode: '80',
            toStopName: 'Prado San Sebastián',
            walkMeters: 180,
            walkSeconds: 150,
            arrivalSeconds: 16 * 3600 + 2 * 60,
            departureSeconds: 16 * 3600 + 9 * 60,
            waitSeconds: 7 * 60,
          },
        ],
        departureSeconds: 15 * 3600 + 54 * 60,
        arrivalSeconds: 16 * 3600 + 21 * 60,
        durationSeconds: 27 * 60,
        transferCount: 1,
        estimated: true,
      },
    ];

    const output = formatTimetable(journeys, { totalCount: 40, limited: true });
    expect(output).toContain('TIMETABLE');
    expect(output).toContain('01');
    expect(output).toContain('15:50');
    expect(output).toContain('C4 → 37');
    expect(output).toContain('~16:21');
    expect(output).toContain('walk 180m (3 min), arrive 16:02, depart 16:09 (00:07)');
    expect(output).toContain('Showing 2 of 40 journeys. Pass --all to view the full day timetable.');
  });

  it('renders live arrivals board with Now, line filtering, and stale notice', () => {
    const arrivals: StopArrivalsResult = {
      stopCode: '43',
      stopName: 'Recaredo (Puerta Carmona)',
      lat: 37.389663,
      lon: -5.984265,
      fetchedAt: '2026-11-24T15:49:21.000Z',
      stale: true,
      arrivals: [
        {
          lineId: 84,
          lineLabel: 'C4',
          color: '#008431',
          destination: 'PLAZA DE ARMAS',
          seconds: 24,
          minutes: 0,
          distanceMeters: 39,
          vehicle: 243,
          attributes: [],
        },
        {
          lineId: 1,
          lineLabel: '01',
          color: '#f54129',
          destination: 'POLIGONO NORTE',
          seconds: 487,
          minutes: 8,
          distanceMeters: 1205,
          vehicle: 1062,
          attributes: [],
        },
      ],
    };

    const full = formatArrivalsTable(arrivals);
    expect(full).toContain('Stop #43 — Recaredo (Puerta Carmona)');
    expect(full).toContain('Showing cached arrival times');
    expect(full).toContain('Now');
    expect(full).toContain('8 min');
    expect(full).toContain('#1062');

    const filtered = formatArrivalsTable(arrivals, '1');
    expect(filtered).toContain('01');
    expect(filtered).not.toContain('PLAZA DE ARMAS');
  });

  it('renders lines, nearby stops, and alerts cleanly', () => {
    const lines: Line[] = [
      {
        id: 81,
        label: 'C1',
        subline: 8110,
        description: 'Circular Exterior 1',
        color: '#008431',
        isCircular: true,
        directions: [{ direction: 99, destination: 'CIRCULAR', startTime: '06:00', endTime: '00:20' }],
      },
    ];
    expect(formatLinesTable(lines)).toContain('Circular');

    const nearby: NearbyStop[] = [
      {
        code: '43',
        name: 'Recaredo (Puerta Carmona)',
        lat: 37.3896,
        lon: -5.9842,
        distanceMeters: 12,
        lines: [{ lineId: 1, label: '01', color: '#f54129' }],
      },
    ];
    expect(formatNearbyTable(nearby)).toContain('12 m');

    const alerts: ServiceAlert[] = [
      {
        id: 1,
        createdAt: '10:00',
        expiresAt: '20:00',
        lines: ['06', 'C1'],
        content: 'Detour active',
        type: 'Notificacion',
      },
    ];
    expect(stripAnsi(formatAlerts(alerts))).toContain('[Lines: 06, C1] Detour active');
    expect(stripAnsi(formatAlerts([]))).toContain('No active TUSSAM service alerts.');
  });
});
