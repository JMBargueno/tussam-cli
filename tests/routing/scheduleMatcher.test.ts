import { describe, expect, it } from 'vitest';
import {
  estimateLegDurationSeconds,
  pairLegDepartures,
} from '../../src/routing/scheduleMatcher.js';
import type { LineStop } from '../../src/types.js';
import { formatSecondsToHHMM, normalizeScheduleSeconds } from '../../src/utils/time.js';

function lineStop(
  code: string,
  distanceMeters: number,
  startTime: string | null,
  lat = 37.38,
  lon = -5.98,
): LineStop {
  return {
    code,
    name: `Stop ${code}`,
    lat,
    lon,
    distanceMeters,
    startTime,
    endTime: null,
    icons: [],
  };
}

describe('scheduleMatcher', () => {
  it('handles after-midnight rollovers cleanly in schedule normalization', () => {
    const normalized = normalizeScheduleSeconds(['23:20:20', '23:40:20', '00:00:20', '00:20:20']);
    expect(normalized).toEqual([84_020, 85_220, 86_420, 87_620]);
    expect(formatSecondsToHHMM(normalized[2]!)).toBe('00:00');
  });

  it('pairs Line 01 departures accurately even when short-turn trips make lengths unequal', () => {
    // Realistic excerpt mirroring TUSSAM Line 01 stop 785 (extra mid-day short-turn) vs stop 58
    const board = normalizeScheduleSeconds([
      '06:17:00',
      '06:31:00',
      '06:44:00',
      '06:50:00', // short-turn trip that does not reach stop 58
      '06:57:00',
      '23:43:00',
    ]);
    const alight = normalizeScheduleSeconds([
      '06:35:11',
      '06:49:11',
      '07:03:02',
      '07:19:44',
      '00:00:20',
    ]);

    const paired = pairLegDepartures(board, alight, 18 * 60);
    expect(paired).toHaveLength(5);
    expect(paired.map((p) => formatSecondsToHHMM(p.departureSeconds))).toEqual([
      '06:17',
      '06:31',
      '06:44',
      '06:57',
      '23:43',
    ]);
    expect(paired.map((p) => formatSecondsToHHMM(p.arrivalSeconds))).toEqual([
      '06:35',
      '06:49',
      '07:03',
      '07:19',
      '00:00',
    ]);
    expect(paired.every((p) => !p.estimated)).toBe(true);
  });

  it('falls back to estimated arrivals when terminus schedule is empty', () => {
    const board = normalizeScheduleSeconds(['08:00:00', '08:15:00']);
    const paired = pairLegDepartures(board, [], 15 * 60);

    expect(paired).toEqual([
      { departureSeconds: 8 * 3600, arrivalSeconds: 8 * 3600 + 900, estimated: true },
      { departureSeconds: 8 * 3600 + 900, arrivalSeconds: 8 * 3600 + 1800, estimated: true },
    ]);
  });

  it('estimates duration for circular lines wrapping past index 0 and terminus "-" stops', () => {
    const circularStops: LineStop[] = [
      lineStop('737', 0, '06:12', 37.410587, -6.006638),
      lineStop('631', 333, '06:13', 37.41262, -6.004918),
      lineStop('738', 853, '06:16', 37.411472, -5.999409),
      lineStop('729', 13_688, '06:23', 37.404693, -6.008252),
      lineStop('730', 14_024, '06:25', 37.407646, -6.007437),
    ];

    const wrapDuration = estimateLegDurationSeconds(circularStops, 3, 2, true);
    expect(wrapDuration).toBeGreaterThanOrEqual(60);

    const terminusStops: LineStop[] = [
      lineStop('58', 7_191, '06:35'),
      lineStop('59', 7_617, '06:10'), // earlier mid-route first trip anomaly
      lineStop('430', 8_671, '-'), // terminus stop without horaInicio
    ];

    const terminusDur = estimateLegDurationSeconds(terminusStops, 0, 2, false);
    expect(terminusDur).toBeGreaterThanOrEqual(200);
    expect(terminusDur).toBeLessThan(900);
  });
});
