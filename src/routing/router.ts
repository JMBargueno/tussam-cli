import type { TussamClient } from '../api/client.js';
import { TussamApiError } from '../api/errors.js';
import type { CacheStore } from '../cache/store.js';
import type {
  Journey,
  JourneyLeg,
  JourneyTransfer,
  NetworkTopology,
  RouteSearchOptions,
  RouteSearchResult,
} from '../types.js';
import {
  formatDateKey,
  isSameLocalDay,
  normalizeScheduleSeconds,
  withLocalTime,
} from '../utils/time.js';
import {
  type CandidateCorridor,
  findAlternativeWalkSuggestion,
  findCandidateCorridors,
} from './corridors.js';
import { type PairedDeparture, pairLegDepartures } from './scheduleMatcher.js';
import {
  DEFAULT_DEST_WALK_METERS,
  DEFAULT_MAX_WALK_METERS,
  DEFAULT_ORIGIN_WALK_METERS,
  DEFAULT_TRANSFER_PENALTY_SECONDS,
  MAX_JOURNEY_SECONDS,
  MAX_TRANSFER_WAIT_SECONDS,
  WALK_ACCESS_PENALTY_SECONDS,
} from './transfers.js';

export type ScheduleLookup = (lineId: number, stopCode: string) => readonly number[];

function journeyScore(journey: Journey): number {
  return (
    journey.durationSeconds +
    journey.transferCount * DEFAULT_TRANSFER_PENALTY_SECONDS +
    (journey.originWalk ? WALK_ACCESS_PENALTY_SECONDS : 0) +
    (journey.destinationWalk ? WALK_ACCESS_PENALTY_SECONDS : 0)
  );
}

function journeySignature(journey: Journey): string {
  const originPart = journey.originWalk
    ? `OW:${journey.originWalk.fromStopCode}->${journey.originWalk.toStopCode}|`
    : '';
  const destPart = journey.destinationWalk
    ? `|DW:${journey.destinationWalk.fromStopCode}->${journey.destinationWalk.toStopCode}`
    : '';
  const legsPart = journey.legs
    .map(
      (leg) =>
        `${leg.lineId}:${leg.direction}:${leg.fromStopCode}:${leg.departureSeconds}->${leg.toStopCode}:${leg.arrivalSeconds}`,
    )
    .join('|');
  return originPart + legsPart + destPart;
}

function sortJourneys(journeys: Journey[], sortByDuration?: boolean): Journey[] {
  if (sortByDuration) {
    journeys.sort(
      (a, b) =>
        a.durationSeconds - b.durationSeconds ||
        a.transferCount - b.transferCount ||
        a.departureSeconds - b.departureSeconds,
    );
  } else {
    journeys.sort(
      (a, b) =>
        a.departureSeconds - b.departureSeconds ||
        a.arrivalSeconds - b.arrivalSeconds ||
        a.transferCount - b.transferCount,
    );
  }
  return journeys;
}

function finalizeJourneys(candidates: readonly Journey[], sortByDuration?: boolean): Journey[] {
  // Retain the highest-scoring journey per exact departure time before Pareto dominance pruning
  // (matches renfe-cli's per-departure selection so a transfer penalty protects direct rides).
  const bestByDeparture = new Map<number, Journey>();
  for (const candidate of candidates) {
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
  return sortJourneys(pruned, sortByDuration);
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
    const cacheKey = `${leg.lineId}:${leg.direction}:${leg.boardStopCode}->${leg.alightStopCode}:${leg.isTerminusAlight ? 1 : 0}`;
    const cached = pairedCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const boardTimes = scheduleLookup(leg.lineId, leg.boardStopCode);
    const alightTimes = scheduleLookup(leg.lineId, leg.alightStopCode);
    const paired = pairLegDepartures(boardTimes, alightTimes, leg.estimatedDurationSeconds, {
      fallbackOnEmptyMatch: Boolean(leg.isTerminusAlight),
    });
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

    const originWalkSeconds = corridor.originWalk?.walkSeconds ?? 0;
    const destWalkSeconds = corridor.destinationWalk?.walkSeconds ?? 0;
    const firstLegList = legDepartures[0]!;

    for (const firstDep of firstLegList) {
      const doorDepartureSeconds = firstDep.departureSeconds - originWalkSeconds;
      if (options.afterSeconds !== undefined && doorDepartureSeconds < options.afterSeconds) {
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

      const departureSeconds = doorDepartureSeconds;
      const arrivalSeconds = prevArrival + destWalkSeconds;
      const durationSeconds = arrivalSeconds - departureSeconds;
      if (durationSeconds <= 0 || durationSeconds > MAX_JOURNEY_SECONDS) {
        continue;
      }

      const journey: Journey = {
        legs,
        transfers,
        ...(corridor.originWalk
          ? {
              originWalk: {
                fromStopCode: corridor.originWalk.fromStopCode,
                fromStopName: stopName(corridor.originWalk.fromStopCode),
                toStopCode: corridor.originWalk.toStopCode,
                toStopName: stopName(corridor.originWalk.toStopCode),
                walkMeters: corridor.originWalk.walkMeters,
                walkSeconds: corridor.originWalk.walkSeconds,
              },
            }
          : {}),
        ...(corridor.destinationWalk
          ? {
              destinationWalk: {
                fromStopCode: corridor.destinationWalk.fromStopCode,
                fromStopName: stopName(corridor.destinationWalk.fromStopCode),
                toStopCode: corridor.destinationWalk.toStopCode,
                toStopName: stopName(corridor.destinationWalk.toStopCode),
                walkMeters: corridor.destinationWalk.walkMeters,
                walkSeconds: corridor.destinationWalk.walkSeconds,
              },
            }
          : {}),
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

  return finalizeJourneys(Array.from(candidatesBySignature.values()), options.sortByDuration);
}

/**
 * Synthesizes offline estimated journeys directly from ArcGIS topology distances and speeds.
 */
export function buildEstimatedJourneysFromCorridors(
  topology: NetworkTopology,
  corridors: readonly CandidateCorridor[],
  options: { anchorSeconds?: number; sortByDuration?: boolean } = {},
): Journey[] {
  const stopName = (code: string): string => topology.stops[code]?.name || code;
  const anchorSeconds = Math.max(0, Math.round(options.anchorSeconds ?? 8 * 3_600));
  const candidatesBySignature = new Map<string, Journey>();

  for (const corridor of corridors) {
    if (corridor.legs.length === 0) {
      continue;
    }

    const originWalkSeconds = corridor.originWalk?.walkSeconds ?? 0;
    const destWalkSeconds = corridor.destinationWalk?.walkSeconds ?? 0;
    let cursor = anchorSeconds + originWalkSeconds;

    const legs: JourneyLeg[] = [];
    const transfers: JourneyTransfer[] = [];

    for (let i = 0; i < corridor.legs.length; i++) {
      const cLeg = corridor.legs[i]!;
      if (i > 0) {
        const cTransfer = corridor.transfers[i - 1]!;
        const waitSeconds = cTransfer.minTransferSeconds + 180;
        const dep = cursor + waitSeconds;
        transfers.push({
          fromStopCode: cTransfer.fromStopCode,
          fromStopName: stopName(cTransfer.fromStopCode),
          toStopCode: cTransfer.toStopCode,
          toStopName: stopName(cTransfer.toStopCode),
          walkMeters: cTransfer.walkMeters,
          walkSeconds: cTransfer.walkSeconds,
          arrivalSeconds: cursor,
          departureSeconds: dep,
          waitSeconds,
        });
        cursor = dep;
      }

      const legDep = cursor;
      const legArr = legDep + Math.max(60, Math.round(cLeg.estimatedDurationSeconds));
      legs.push({
        lineId: cLeg.lineId,
        lineLabel: cLeg.lineLabel,
        lineColor: cLeg.lineColor,
        direction: cLeg.direction,
        fromStopCode: cLeg.boardStopCode,
        fromStopName: stopName(cLeg.boardStopCode),
        toStopCode: cLeg.alightStopCode,
        toStopName: stopName(cLeg.alightStopCode),
        departureSeconds: legDep,
        arrivalSeconds: legArr,
        stopsCount: cLeg.stopsCount,
        estimated: true,
      });
      cursor = legArr;
    }

    const departureSeconds = anchorSeconds;
    const arrivalSeconds = cursor + destWalkSeconds;
    const durationSeconds = arrivalSeconds - departureSeconds;
    if (durationSeconds <= 0 || durationSeconds > MAX_JOURNEY_SECONDS) {
      continue;
    }

    const journey: Journey = {
      legs,
      transfers,
      ...(corridor.originWalk
        ? {
            originWalk: {
              fromStopCode: corridor.originWalk.fromStopCode,
              fromStopName: stopName(corridor.originWalk.fromStopCode),
              toStopCode: corridor.originWalk.toStopCode,
              toStopName: stopName(corridor.originWalk.toStopCode),
              walkMeters: corridor.originWalk.walkMeters,
              walkSeconds: corridor.originWalk.walkSeconds,
            },
          }
        : {}),
      ...(corridor.destinationWalk
        ? {
            destinationWalk: {
              fromStopCode: corridor.destinationWalk.fromStopCode,
              fromStopName: stopName(corridor.destinationWalk.fromStopCode),
              toStopCode: corridor.destinationWalk.toStopCode,
              toStopName: stopName(corridor.destinationWalk.toStopCode),
              walkMeters: corridor.destinationWalk.walkMeters,
              walkSeconds: corridor.destinationWalk.walkSeconds,
            },
          }
        : {}),
      departureSeconds,
      arrivalSeconds,
      durationSeconds,
      transferCount: transfers.length,
      estimated: true,
    };

    const sig = journeySignature(journey);
    if (!candidatesBySignature.has(sig)) {
      candidatesBySignature.set(sig, journey);
    }
  }

  return finalizeJourneys(Array.from(candidatesBySignature.values()), options.sortByDuration);
}

function splitIntoHydrationBatches(
  corridors: readonly CandidateCorridor[],
  firstBatchSize: number,
): CandidateCorridor[][] {
  if (corridors.length === 0) {
    return [];
  }
  const batches: CandidateCorridor[][] = [];
  const firstSize = Math.max(1, firstBatchSize);
  batches.push(corridors.slice(0, firstSize));
  for (let i = firstSize; i < corridors.length; i += 2) {
    batches.push(corridors.slice(i, i + 2));
  }
  return batches;
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs Phase 1 corridor discovery, progressively hydrates missing stop schedules in bounded
 * batches with an HTTP 429 circuit breaker, and computes Pareto-optimal timed journeys.
 */
export async function routeWithHydrationDetailed(
  client: TussamClient,
  cache: CacheStore,
  topology: NetworkTopology,
  options: RouteSearchOptions,
): Promise<RouteSearchResult> {
  const maxTransfers = options.maxTransfers ?? 2;
  const maxWalkMeters = options.maxWalkMeters ?? DEFAULT_MAX_WALK_METERS;
  const maxOriginWalkMeters = Math.max(
    0,
    options.maxOriginWalkMeters ?? DEFAULT_ORIGIN_WALK_METERS,
  );
  const maxDestWalkMeters = Math.max(0, options.maxDestWalkMeters ?? DEFAULT_DEST_WALK_METERS);

  const corridors = findCandidateCorridors(topology, options.fromStopCode, options.toStopCode, {
    maxTransfers,
    maxWalkMeters,
    maxOriginWalkMeters,
    maxDestWalkMeters,
    maxCorridors: 6,
    includeNight: options.includeNight,
  });

  const walkSuggestion =
    maxOriginWalkMeters === 0 || maxDestWalkMeters === 0
      ? findAlternativeWalkSuggestion(
          topology,
          options.fromStopCode,
          options.toStopCode,
          corridors,
          {
            maxTransfers,
            maxWalkMeters,
            maxOriginWalkMeters,
            maxDestWalkMeters,
            maxCorridors: 6,
            includeNight: options.includeNight,
          },
        )
      : undefined;

  if (corridors.length === 0) {
    return {
      journeys: [],
      rateLimited: false,
      partial: false,
      estimatedFallback: Boolean(options.estimate),
      hydratedCorridors: 0,
      totalCorridors: 0,
      warnings: [],
      ...(walkSuggestion ? { walkSuggestion } : {}),
    };
  }

  const now = new Date();
  const baseDate = options.date ?? now;
  const dateKey = formatDateKey(baseDate);
  const queryDateTime = withLocalTime(baseDate, 12, 0, 0);

  const normalizedSchedules = new Map<string, number[]>();
  const hydratedKeys = new Set<string>();
  const attemptedKeys = new Set<string>();

  for (const corridor of corridors) {
    for (const leg of corridor.legs) {
      const endpoints = [
        { lineId: leg.lineId, stopCode: leg.boardStopCode },
        { lineId: leg.lineId, stopCode: leg.alightStopCode },
      ];
      for (const endpoint of endpoints) {
        const key = `${endpoint.lineId}:${endpoint.stopCode}`;
        if (normalizedSchedules.has(key)) {
          continue;
        }
        const shouldUseCache = !options.refresh || Boolean(options.estimate);
        const cached = shouldUseCache
          ? await cache.getSchedule(dateKey, endpoint.lineId, endpoint.stopCode)
          : null;
        if (cached) {
          normalizedSchedules.set(key, normalizeScheduleSeconds(cached));
          hydratedKeys.add(key);
          attemptedKeys.add(key);
        }
      }
    }
  }

  const countHydratedCorridors = (): number =>
    corridors.filter((corridor) =>
      corridor.legs.every(
        (leg) =>
          hydratedKeys.has(`${leg.lineId}:${leg.boardStopCode}`) &&
          hydratedKeys.has(`${leg.lineId}:${leg.alightStopCode}`),
      ),
    ).length;

  if (options.estimate) {
    const cachedCorridors = corridors.filter((corridor) =>
      corridor.legs.every(
        (leg) =>
          hydratedKeys.has(`${leg.lineId}:${leg.boardStopCode}`) &&
          hydratedKeys.has(`${leg.lineId}:${leg.alightStopCode}`),
      ),
    );
    const timedJourneys =
      cachedCorridors.length > 0
        ? findJourneysFromCorridors(
            topology,
            cachedCorridors,
            (lineId, stopCode) => normalizedSchedules.get(`${lineId}:${stopCode}`) ?? [],
            {
              sortByDuration: options.sortByDuration,
              afterSeconds: options.afterSeconds,
            },
          )
        : [];

    const uncachedCorridors =
      timedJourneys.length === 0
        ? corridors
        : corridors.filter((corridor) => !cachedCorridors.includes(corridor));

    const defaultAnchor = isSameLocalDay(baseDate, now)
      ? now.getHours() * 3600 + now.getMinutes() * 60
      : 8 * 3600;
    const anchorSeconds = options.afterSeconds ?? defaultAnchor;

    const estJourneys =
      uncachedCorridors.length > 0
        ? buildEstimatedJourneysFromCorridors(topology, uncachedCorridors, {
            anchorSeconds,
            sortByDuration: options.sortByDuration,
          })
        : [];

    const combined = sortJourneys(
      removeDominated([...timedJourneys, ...estJourneys]),
      options.sortByDuration,
    );

    return {
      journeys: combined,
      rateLimited: false,
      partial: false,
      estimatedFallback: true,
      hydratedCorridors: cachedCorridors.length,
      totalCorridors: corridors.length,
      warnings: ['Showing offline topology-based route estimates (--estimate).'],
      ...(walkSuggestion ? { walkSuggestion } : {}),
    };
  }

  const firstBatchSize =
    options.hydrationBatchSize ?? (corridors[0]?.transfers.length === 0 ? 3 : 2);
  const batches = splitIntoHydrationBatches(corridors, firstBatchSize);
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? 120);

  const abortController = new AbortController();
  const state: {
    circuitOpen: boolean;
    rateLimitError: TussamApiError | null;
    lastApiError: TussamApiError | null;
    uncachedAttemptCount: number;
    uncachedSuccessCount: number;
  } = {
    circuitOpen: false,
    rateLimitError: null,
    lastApiError: null,
    uncachedAttemptCount: 0,
    uncachedSuccessCount: 0,
  };

  for (const batch of batches) {
    if (state.circuitOpen || abortController.signal.aborted) {
      break;
    }

    const batchPending: Array<{ key: string; lineId: number; stopCode: string }> = [];
    for (const corridor of batch) {
      for (const leg of corridor.legs) {
        const pair = [
          { lineId: leg.lineId, stopCode: leg.boardStopCode },
          { lineId: leg.lineId, stopCode: leg.alightStopCode },
        ];
        for (const endpoint of pair) {
          const key = `${endpoint.lineId}:${endpoint.stopCode}`;
          if (!attemptedKeys.has(key)) {
            attemptedKeys.add(key);
            batchPending.push({ key, lineId: endpoint.lineId, stopCode: endpoint.stopCode });
          }
        }
      }
    }

    if (batchPending.length === 0) {
      continue;
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (
        cursor < batchPending.length &&
        !state.circuitOpen &&
        !abortController.signal.aborted
      ) {
        const index = cursor;
        cursor += 1;
        const item = batchPending[index]!;
        state.uncachedAttemptCount += 1;

        try {
          const line = topology.lines[String(item.lineId)];
          const isNight = line ? /^A\d/i.test(line.label.trim()) : false;
          const fetchTime = isNight ? withLocalTime(baseDate, 1, 30, 0) : queryDateTime;
          const rawTimes = await client.fetchStopSchedule(item.stopCode, item.lineId, fetchTime, {
            signal: abortController.signal,
          });
          await cache
            .saveSchedule(dateKey, item.lineId, item.stopCode, rawTimes)
            .catch(() => undefined);
          normalizedSchedules.set(item.key, normalizeScheduleSeconds(rawTimes));
          hydratedKeys.add(item.key);
          state.uncachedSuccessCount += 1;
        } catch (err) {
          if (err instanceof TussamApiError && err.statusCode === 429) {
            state.circuitOpen = true;
            state.rateLimitError = err;
            abortController.abort();
            break;
          }
          if (err instanceof TussamApiError && !abortController.signal.aborted) {
            state.lastApiError = err;
          }
          if (!normalizedSchedules.has(item.key)) {
            normalizedSchedules.set(item.key, []);
          }
        }

        if (
          cursor < batchPending.length &&
          !state.circuitOpen &&
          !abortController.signal.aborted &&
          requestDelayMs > 0
        ) {
          await sleepWithAbort(requestDelayMs, abortController.signal);
        }
      }
    };

    const workerCount = Math.min(2, batchPending.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  const hydratedCorridors = countHydratedCorridors();
  const journeys = findJourneysFromCorridors(
    topology,
    corridors,
    (lineId, stopCode) => normalizedSchedules.get(`${lineId}:${stopCode}`) ?? [],
    {
      sortByDuration: options.sortByDuration,
      afterSeconds: options.afterSeconds,
    },
  );

  if (state.circuitOpen) {
    if (journeys.length > 0) {
      return {
        journeys,
        rateLimited: true,
        partial: true,
        estimatedFallback: false,
        hydratedCorridors,
        totalCorridors: corridors.length,
        warnings: [
          `TUSSAM rate limit (HTTP 429) reached; showing partial results from ${hydratedCorridors}/${corridors.length} corridors. Pass --estimate for offline topology estimates.`,
        ],
        ...(walkSuggestion ? { walkSuggestion } : {}),
      };
    }

    throw new TussamApiError(
      `${state.rateLimitError?.message ?? 'TUSSAM upstream rate-limited (HTTP 429)'}. Pass --estimate for offline topology estimates.`,
      429,
      state.rateLimitError?.url,
      state.rateLimitError?.retryAfterMs,
    );
  }

  if (
    state.uncachedAttemptCount > 0 &&
    state.uncachedSuccessCount === 0 &&
    state.lastApiError &&
    journeys.length === 0
  ) {
    throw state.lastApiError;
  }

  return {
    journeys,
    rateLimited: false,
    partial: false,
    estimatedFallback: false,
    hydratedCorridors,
    totalCorridors: corridors.length,
    warnings: [],
    ...(walkSuggestion ? { walkSuggestion } : {}),
  };
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
  const result = await routeWithHydrationDetailed(client, cache, topology, options);
  return result.journeys;
}
