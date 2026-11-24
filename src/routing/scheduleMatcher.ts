import type { LineStop } from '../types.js';
import { haversineMeters } from '../utils/geo.js';
import { parseClockToSeconds } from '../utils/time.js';

const DEFAULT_BUS_SPEED_MPS = 4.2;
const MIN_REALISTIC_SPEED_MPS = 2.0;
const MAX_REALISTIC_SPEED_MPS = 12.0;
const FALLBACK_LOOP_GAP_METERS = 350;
const SECONDS_PER_DAY = 86_400;

export interface PairedDeparture {
  departureSeconds: number;
  arrivalSeconds: number;
  estimated: boolean;
}

function estimateTotalCircularDistance(stops: readonly LineStop[]): number {
  if (stops.length === 0) {
    return 0;
  }
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  let closingGap = FALLBACK_LOOP_GAP_METERS;
  if (first.lat !== null && first.lon !== null && last.lat !== null && last.lon !== null) {
    const gap = haversineMeters(last.lat, last.lon, first.lat, first.lon);
    if (Number.isFinite(gap) && gap > 0) {
      closingGap = gap;
    }
  }
  return last.distanceMeters + closingGap;
}

function estimateAverageLineSpeed(stops: readonly LineStop[]): number {
  let prevDist: number | null = null;
  let prevSec: number | null = null;
  let totalDist = 0;
  let totalSec = 0;

  for (const stop of stops) {
    const rawSec = parseClockToSeconds(stop.startTime);
    if (rawSec === null) {
      continue;
    }
    if (prevDist !== null && prevSec !== null) {
      let deltaT = rawSec - prevSec;
      if (deltaT < -6 * 3600) {
        deltaT += SECONDS_PER_DAY;
      }
      const deltaD = stop.distanceMeters - prevDist;
      if (deltaD > 50 && deltaT > 0) {
        const speed = deltaD / deltaT;
        if (speed >= MIN_REALISTIC_SPEED_MPS && speed <= MAX_REALISTIC_SPEED_MPS) {
          totalDist += deltaD;
          totalSec += deltaT;
        }
      }
    }
    prevDist = stop.distanceMeters;
    prevSec = rawSec;
  }

  if (totalSec > 0 && totalDist > 0) {
    const avg = totalDist / totalSec;
    return Math.max(MIN_REALISTIC_SPEED_MPS, Math.min(MAX_REALISTIC_SPEED_MPS, avg));
  }
  return DEFAULT_BUS_SPEED_MPS;
}

/**
 * Estimates travel duration in seconds between two stops along a line sequence,
 * handling circular wrap-around (`sentido === 99`) and terminus stops with missing `horaInicio` (`"-"`).
 */
export function estimateLegDurationSeconds(
  stops: readonly LineStop[],
  boardIdx: number,
  alightIdx: number,
  isCircular: boolean,
): number {
  const boardStop = stops[boardIdx];
  const alightStop = stops[alightIdx];
  if (!boardStop || !alightStop) {
    return 60;
  }

  let deltaDistance: number;
  if (!isCircular || boardIdx <= alightIdx) {
    deltaDistance = Math.max(0, alightStop.distanceMeters - boardStop.distanceMeters);
  } else {
    const totalLoop = estimateTotalCircularDistance(stops);
    deltaDistance = Math.max(0, totalLoop - boardStop.distanceMeters + alightStop.distanceMeters);
  }

  if (!isCircular || boardIdx < alightIdx) {
    const startA = parseClockToSeconds(boardStop.startTime);
    const startB = parseClockToSeconds(alightStop.startTime);
    if (startA !== null && startB !== null) {
      let diff = startB - startA;
      if (diff < -6 * 3600) {
        diff += SECONDS_PER_DAY;
      }
      if (diff > 0) {
        const impliedSpeed = deltaDistance > 0 ? deltaDistance / diff : DEFAULT_BUS_SPEED_MPS;
        if (impliedSpeed >= MIN_REALISTIC_SPEED_MPS && impliedSpeed <= MAX_REALISTIC_SPEED_MPS) {
          return diff;
        }
      }
    }
  }

  const avgSpeed = estimateAverageLineSpeed(stops);
  if (
    deltaDistance === 0 &&
    boardStop.lat !== null &&
    boardStop.lon !== null &&
    alightStop.lat !== null &&
    alightStop.lon !== null
  ) {
    deltaDistance =
      haversineMeters(boardStop.lat, boardStop.lon, alightStop.lat, alightStop.lon) * 1.25;
  }
  return Math.max(60, Math.round(deltaDistance / avgSpeed));
}

/**
 * Pairs departure times at `boardStop` with arrival times at `alightStop` via
 * maximum-cardinality monotonic sequence alignment anchored to `expectedDurationSec`.
 *
 * Handles short-turn trips (where `boardTimesSec` and `alightTimesSec` have different lengths)
 * and terminus stops whose schedule endpoint returns an empty list (estimated fallback).
 */
export function pairLegDepartures(
  boardTimesSec: readonly number[],
  alightTimesSec: readonly number[],
  expectedDurationSec: number,
  options: { fallbackOnEmptyMatch?: boolean } = {},
): PairedDeparture[] {
  if (boardTimesSec.length === 0) {
    return [];
  }

  const safeExpected = Math.max(60, Math.round(expectedDurationSec));

  if (alightTimesSec.length === 0) {
    return boardTimesSec.map((dep) => ({
      departureSeconds: dep,
      arrivalSeconds: dep + safeExpected,
      estimated: true,
    }));
  }

  const minTravel = Math.max(30, Math.round(Math.min(safeExpected * 0.5, safeExpected - 180)));
  const maxTravel = Math.max(Math.round(safeExpected * 1.85), safeExpected + 600);

  const m = boardTimesSec.length;
  const n = alightTimesSec.length;
  const MATCH_REWARD = 1_000_000;
  const cols = n + 1;

  // Flat DP table maximizing matched pairs first, minimizing total travel-time deviation second.
  const dp = new Float64Array((m + 1) * cols);
  // Choice codes: 0 = skip board, 1 = skip alight, 2 = match (i-1, j-1)
  const choice = new Uint8Array((m + 1) * cols);

  for (let i = 1; i <= m; i++) {
    const dep = boardTimesSec[i - 1]!;
    const rowOffset = i * cols;
    const prevRowOffset = (i - 1) * cols;

    for (let j = 1; j <= n; j++) {
      const idx = rowOffset + j;
      let bestScore = dp[prevRowOffset + j]!;
      let bestChoice = 0;

      const skipAlightScore = dp[rowOffset + j - 1]!;
      if (skipAlightScore > bestScore) {
        bestScore = skipAlightScore;
        bestChoice = 1;
      }

      const arr = alightTimesSec[j - 1]!;
      const travel = arr - dep;
      if (travel >= minTravel && travel <= maxTravel) {
        const matchScore =
          dp[prevRowOffset + j - 1]! + MATCH_REWARD - Math.abs(travel - safeExpected);
        if (matchScore > bestScore) {
          bestScore = matchScore;
          bestChoice = 2;
        }
      }

      dp[idx] = bestScore;
      choice[idx] = bestChoice;
    }
  }

  const paired: PairedDeparture[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const c = choice[i * cols + j];
    if (c === 2) {
      paired.push({
        departureSeconds: boardTimesSec[i - 1]!,
        arrivalSeconds: alightTimesSec[j - 1]!,
        estimated: false,
      });
      i -= 1;
      j -= 1;
    } else if (c === 0) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  paired.reverse();
  if (paired.length === 0 && options.fallbackOnEmptyMatch) {
    return boardTimesSec.map((dep) => ({
      departureSeconds: dep,
      arrivalSeconds: dep + safeExpected,
      estimated: true,
    }));
  }
  return paired;
}
