import { TussamClient } from '../api/client.js';
import { TussamApiError } from '../api/errors.js';
import { CacheStore } from '../cache/store.js';
import type {
  Journey,
  JourneyLeg,
  JourneyTransfer,
  NetworkTopology,
  RouteSearchOptions,
} from '../types.js';
import { formatDateKey, normalizeScheduleSeconds, withLocalTime } from '../utils/time.js';
import { type CandidateCorridor, findCandidateCorridors } from './corridors.js';
import { type PairedDeparture, pairLegDepartures } from './scheduleMatcher.js';
import {
  DEFAULT_MAX_WALK_METERS,
  DEFAULT_TRANSFER_PENALTY_SECONDS,
  MAX_JOURNEY_SECONDS,
  MAX_TRANSFER_WAIT_SECONDS,
} from './transfers.js';

export type ScheduleLookup = (lineId: number, stopCode: string) => readonly number[];

function journeyScore(journey: Journey): number {
  return journey.durationSeconds + journey.transferCount * DEFAULT_TRANSFER_PENALTY_SECONDS;
}

function journeySignature(journey: Journey): string {
  return journey.legs
    .map(
      (leg) =>
        `${leg.lineId}:${leg.direction}:${leg.fromStopCode}:${leg.departureSeconds}->${leg.toStopCode}:${leg.arrivalSeconds}`,
    )
    .join('|');
}

function findFirstDepartureAtOrAfter(
  departures: readonly PairedDeparture[],
  minDepartureSec: number,
): PairedDeparture | null {
  let lo = 0;
  let hi = departures.length - 1;
  let match: PairedDeparture | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = departures[mid]!;
    if (candidate.departureSeconds >= minDepartureSec) {
      match = candidate;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return match;
}

/**
 * Removes Pareto-dominated journeys (mirrors `renfe-cli/src/router.rs`).
 * A journey `A` is dominated if another journey `B` departs no earlier, arrives no later,
 * has no more transfers, and is strictly better in at least one of those three metrics.
 */
export function removeDominated(journeys: readonly Journey[]): Journey[] {
  return journeys.filter((journey, idx) => {
    return !journeys.some((other, otherIdx) => {
      if (idx === otherIdx) {
        return false;
      }
      const noWorse =
        other.departureSeconds >= journey.departureSeconds &&
        other.arrivalSeconds <= journey.arrivalSeconds &&
        other.transferCount <= journey.transferCount;
      if (!noWorse) {
        return false;
      }
      return (
        other.departureSeconds > journey.departureSeconds ||
        other.arrivalSeconds < journey.arrivalSeconds ||
        other.transferCount < journey.transferCount
      );
    });
  });
}

/**
 * Materializes exact timed journeys for pre-discovered candidate corridors using a schedule lookup.
 */
export function findJourneysFromCorridors(
  topology: NetworkTopology,
  corridors: readonly CandidateCorridor[],
  scheduleLookup: ScheduleLookup,
  options: { sortByDuration?: boolean; afterSeconds?: number } = {},
): Journey[] {
  const stopName = (code: string): string => topology.stops[code]?.name || code;
  const pairedCache = new Map<string, PairedDeparture[]>();

  const getPairedForLeg = (leg: CandidateCorridor['legs'][number]): PairedDeparture[] => {
    const cacheKey = `${leg.lineId}:${leg.direction}:${leg.boardStopCode}->${leg.alightStopCode}`;
    const cached = pairedCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const boardTimes = scheduleLookup(leg.lineId, leg.boardStopCode);
    const alightTimes = scheduleLookup(leg.lineId, leg.alightStopCode);
    const paired = pairLegDepartures(boardTimes, alightTimes, leg.estimatedDurationSeconds);
    pairedCache.set(cacheKey, paired);
    return paired;
  };

  const candidatesBySignature = new Map<string, Journey>();

  for (const corridor of corridors) {
    if (corridor.legs.length === 0) {
      continue;
    }

    const legDepartures = corridor.legs.map(getPairedForLeg);
    if (legDepartures.some((list) => list.length === 0)) {
      continue;
    }

    const firstLegList = legDepartures[0]!;
    for (const firstDep of firstLegList) {
      if (
        options.afterSeconds !== undefined &&
        firstDep.departureSeconds < options.afterSeconds
      ) {
        continue;
      }

      const legs: JourneyLeg[] = [
        {
          lineId: corridor.legs[0]!.lineId,
          lineLabel: corridor.legs[0]!.lineLabel,
          lineColor: corridor.legs[0]!.lineColor,
          direction: corridor.legs[0]!.direction,
          fromStopCode: corridor.legs[0]!.boardStopCode,
          fromStopName: stopName(corridor.legs[0]!.boardStopCode),
          toStopCode: corridor.legs[0]!.alightStopCode,
          toStopName: stopName(corridor.legs[0]!.alightStopCode),
          departureSeconds: firstDep.departureSeconds,
          arrivalSeconds: firstDep.arrivalSeconds,
          stopsCount: corridor.legs[0]!.stopsCount,
          estimated: firstDep.estimated,
        },
      ];

      const transfers: JourneyTransfer[] = [];
      let prevArrival = firstDep.arrivalSeconds;
      let valid = true;

      for (let i = 1; i < corridor.legs.length; i++) {
        const corridorLeg = corridor.legs[i]!;
        const corridorTransfer = corridor.transfers[i - 1]!;
        const minConnectDep = prevArrival + corridorTransfer.minTransferSeconds;
        const nextDep = findFirstDepartureAtOrAfter(legDepartures[i]!, minConnectDep);

        if (!nextDep) {
          valid = false;
          break;
        }

        const waitSeconds = nextDep.departureSeconds - prevArrival;
        if (waitSeconds > MAX_TRANSFER_WAIT_SECONDS) {
          valid = false;
          break;
        }

        transfers.push({
          fromStopCode: corridorTransfer.fromStopCode,
          fromStopName: stopName(corridorTransfer.fromStopCode),
          toStopCode: corridorTransfer.toStopCode,
          toStopName: stopName(corridorTransfer.toStopCode),
          walkMeters: corridorTransfer.walkMeters,
          walkSeconds: corridorTransfer.walkSeconds,
          arrivalSeconds: prevArrival,
          departureSeconds: nextDep.departureSeconds,
          waitSeconds,
        });

        legs.push({
          lineId: corridorLeg.lineId,
          lineLabel: corridorLeg.lineLabel,
          lineColor: corridorLeg.lineColor,
          direction: corridorLeg.direction,
          fromStopCode: corridorLeg.boardStopCode,
          fromStopName: stopName(corridorLeg.boardStopCode),
          toStopCode: corridorLeg.alightStopCode,
          toStopName: stopName(corridorLeg.alightStopCode),
          departureSeconds: nextDep.departureSeconds,
          arrivalSeconds: nextDep.arrivalSeconds,
          stopsCount: corridorLeg.stopsCount,
          estimated: nextDep.estimated,
        });

        prevArrival = nextDep.arrivalSeconds;
      }

      if (!valid) {
        continue;
      }

      const departureSeconds = legs[0]!.departureSeconds;
      const arrivalSeconds = legs[legs.length - 1]!.arrivalSeconds;
      const durationSeconds = arrivalSeconds - departureSeconds;
      if (durationSeconds <= 0 || durationSeconds > MAX_JOURNEY_SECONDS) {
        continue;
      }

      const journey: Journey = {
        legs,
        transfers,
        departureSeconds,
        arrivalSeconds,
        durationSeconds,
        transferCount: transfers.length,
        estimated: legs.some((l) => l.estimated),
      };

      const sig = journeySignature(journey);
      if (!candidatesBySignature.has(sig)) {
        candidatesBySignature.set(sig, journey);
      }
    }
  }

  // Retain the highest-scoring journey per exact departure time before Pareto dominance pruning
  // (matches renfe-cli's per-departure selection so a transfer penalty protects direct rides).
  const bestByDeparture = new Map<number, Journey>();
  for (const candidate of candidatesBySignature.values()) {
    const existing = bestByDeparture.get(candidate.departureSeconds);
    if (
      !existing ||
      journeyScore(candidate) < journeyScore(existing) ||
      (journeyScore(candidate) === journeyScore(existing) &&
        (candidate.arrivalSeconds < existing.arrivalSeconds ||
          (candidate.arrivalSeconds === existing.arrivalSeconds &&
            candidate.transferCount < existing.transferCount)))
    ) {
      bestByDeparture.set(candidate.departureSeconds, candidate);
    }
  }

  const allCandidates = Array.from(bestByDeparture.values());
  allCandidates.sort(
    (a, b) =>
      a.departureSeconds - b.departureSeconds ||
      journeyScore(a) - journeyScore(b) ||
      a.arrivalSeconds - b.arrivalSeconds,
  );

  const pruned = removeDominated(allCandidates);

  if (options.sortByDuration) {
    pruned.sort(
      (a, b) =>
        a.durationSeconds - b.durationSeconds ||
        a.transferCount - b.transferCount ||
        a.departureSeconds - b.departureSeconds,
    );
  } else {
    pruned.sort(
      (a, b) =>
        a.departureSeconds - b.departureSeconds ||
        a.arrivalSeconds - b.arrivalSeconds ||
        a.transferCount - b.transferCount,
    );
  }

  return pruned;
}

/**
 * Runs Phase 1 corridor discovery, lazily hydrates missing stop schedules from cache or API,
 * and computes Pareto-optimal timed journeys.
 */
export async function routeWithHydration(
  client: TussamClient,
  cache: CacheStore,
  topology: NetworkTopology,
  options: RouteSearchOptions,
): Promise<Journey[]> {
  const corridors = findCandidateCorridors(topology, options.fromStopCode, options.toStopCode, {
    maxTransfers: options.maxTransfers ?? 2,
    maxWalkMeters: options.maxWalkMeters ?? DEFAULT_MAX_WALK_METERS,
    maxCorridors: 6,
    includeNight: options.includeNight,
  });

  if (corridors.length === 0) {
    return [];
  }

  const baseDate = options.date ?? new Date();
  const dateKey = formatDateKey(baseDate);
  const queryDateTime = withLocalTime(baseDate, 12, 0, 0);

  const scheduleEndpoints = new Map<string, { lineId: number; stopCode: string }>();
  for (const corridor of corridors) {
    for (const leg of corridor.legs) {
      scheduleEndpoints.set(`${leg.lineId}:${leg.boardStopCode}`, {
        lineId: leg.lineId,
        stopCode: leg.boardStopCode,
      });
      scheduleEndpoints.set(`${leg.lineId}:${leg.alightStopCode}`, {
        lineId: leg.lineId,
        stopCode: leg.alightStopCode,
      });
    }
  }

  const normalizedSchedules = new Map<string, number[]>();
  const pendingEndpoints: Array<{ key: string; lineId: number; stopCode: string }> = [];

  for (const [key, endpoint] of scheduleEndpoints.entries()) {
    const cached = options.refresh
      ? null
      : await cache.getSchedule(dateKey, endpoint.lineId, endpoint.stopCode);
    if (cached) {
      normalizedSchedules.set(key, normalizeScheduleSeconds(cached));
    } else {
      pendingEndpoints.push({ key, lineId: endpoint.lineId, stopCode: endpoint.stopCode });
    }
  }

  if (pendingEndpoints.length > 0) {
    let uncachedAttemptCount = 0;
    let uncachedSuccessCount = 0;
    let lastApiError: TussamApiError | null = null;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < pendingEndpoints.length) {
        const index = cursor;
        cursor += 1;
        const item = pendingEndpoints[index]!;
        uncachedAttemptCount += 1;

        try {
          const line = topology.lines[String(item.lineId)];
          const isNight = line ? /^A\d/i.test(line.label.trim()) : false;
          const fetchTime = isNight ? withLocalTime(baseDate, 1, 30, 0) : queryDateTime;
          const rawTimes = await client.fetchStopSchedule(item.stopCode, item.lineId, fetchTime);
          await cache.saveSchedule(dateKey, item.lineId, item.stopCode, rawTimes);
          normalizedSchedules.set(item.key, normalizeScheduleSeconds(rawTimes));
          uncachedSuccessCount += 1;
        } catch (err) {
          if (err instanceof TussamApiError) {
            lastApiError = err;
          }
          normalizedSchedules.set(item.key, []);
        }

        if (cursor < pendingEndpoints.length) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    };

    const workerCount = Math.min(2, pendingEndpoints.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (uncachedAttemptCount > 0 && uncachedSuccessCount === 0 && lastApiError) {
      throw lastApiError;
    }
  }

  return findJourneysFromCorridors(
    topology,
    corridors,
    (lineId, stopCode) => normalizedSchedules.get(`${lineId}:${stopCode}`) ?? [],
    {
      sortByDuration: options.sortByDuration,
      afterSeconds: options.afterSeconds,
    },
  );
}
