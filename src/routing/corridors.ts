import type { Line, LineStop, NetworkTopology, RouteWalkSuggestion } from '../types.js';
import { estimateLegDurationSeconds } from './scheduleMatcher.js';
import {
  buildWalkTransferMap,
  DEFAULT_DEST_WALK_METERS,
  DEFAULT_MAX_WALK_METERS,
  DEFAULT_ORIGIN_WALK_METERS,
  DEFAULT_SAME_STOP_TRANSFER_SECONDS,
  DEFAULT_TRANSFER_PENALTY_SECONDS,
  findNearbyAccessWalks,
  WALK_ACCESS_PENALTY_SECONDS,
} from './transfers.js';

export interface CorridorLeg {
  lineId: number;
  lineLabel: string;
  lineColor: string;
  direction: number;
  isCircular: boolean;
  boardStopCode: string;
  alightStopCode: string;
  boardIdx: number;
  alightIdx: number;
  stopsCount: number;
  estimatedDurationSeconds: number;
  isTerminusAlight?: boolean;
}

export interface CorridorTransfer {
  fromStopCode: string;
  toStopCode: string;
  walkMeters: number;
  walkSeconds: number;
  minTransferSeconds: number;
}

export interface CorridorAccessWalk {
  fromStopCode: string;
  toStopCode: string;
  walkMeters: number;
  walkSeconds: number;
}

export interface CandidateCorridor {
  legs: CorridorLeg[];
  transfers: CorridorTransfer[];
  originWalk?: CorridorAccessWalk;
  destinationWalk?: CorridorAccessWalk;
  estimatedTotalSeconds: number;
}

export interface CorridorSearchOptions {
  maxTransfers?: number;
  maxWalkMeters?: number;
  maxOriginWalkMeters?: number;
  maxDestWalkMeters?: number;
  maxCorridors?: number;
  includeNight?: boolean;
}

interface LineSequence {
  line: Line;
  direction: number;
  stops: LineStop[];
}

interface RoundLabel {
  estimatedArrival: number;
  legs: CorridorLeg[];
  transfers: CorridorTransfer[];
  originWalk?: CorridorAccessWalk;
  pendingTransfer?: CorridorTransfer;
}

function corridorSignature(
  corridor: Pick<CandidateCorridor, 'legs' | 'originWalk' | 'destinationWalk'>,
): string {
  const originPart = corridor.originWalk
    ? `OW:${corridor.originWalk.fromStopCode}->${corridor.originWalk.toStopCode}|`
    : '';
  const destPart = corridor.destinationWalk
    ? `|DW:${corridor.destinationWalk.fromStopCode}->${corridor.destinationWalk.toStopCode}`
    : '';
  const legsPart = corridor.legs
    .map((l) => `${l.lineId}:${l.direction}:${l.boardStopCode}->${l.alightStopCode}`)
    .join('|');
  return originPart + legsPart + destPart;
}

function corridorScore(corridor: CandidateCorridor): number {
  return (
    corridor.estimatedTotalSeconds +
    corridor.transfers.length * DEFAULT_TRANSFER_PENALTY_SECONDS +
    (corridor.originWalk ? WALK_ACCESS_PENALTY_SECONDS : 0) +
    (corridor.destinationWalk ? WALK_ACCESS_PENALTY_SECONDS : 0)
  );
}

function roundLabelCost(label: RoundLabel): number {
  return label.estimatedArrival + (label.originWalk ? WALK_ACCESS_PENALTY_SECONDS : 0);
}

/**
 * Phase 1: Discovers direct and transfer corridors over the cached network topology in `< 5ms`.
 */
export function findCandidateCorridors(
  topology: NetworkTopology,
  originCode: string,
  destinationCode: string,
  options: CorridorSearchOptions = {},
): CandidateCorridor[] {
  if (!originCode || !destinationCode || originCode === destinationCode) {
    return [];
  }

  const maxTransfers = Math.max(0, Math.min(3, options.maxTransfers ?? 2));
  const maxWalkMeters = options.maxWalkMeters ?? DEFAULT_MAX_WALK_METERS;
  const maxOriginWalkMeters = Math.max(0, options.maxOriginWalkMeters ?? 0);
  const maxDestWalkMeters = Math.max(0, options.maxDestWalkMeters ?? 0);
  const maxCorridors = Math.max(1, options.maxCorridors ?? 6);
  const includeNight = Boolean(options.includeNight);

  const walkMap =
    maxTransfers > 0 ? buildWalkTransferMap(topology.stops, maxWalkMeters) : new Map();

  const destWalkByStop = new Map<string, { walkMeters: number; walkSeconds: number }>();
  if (maxDestWalkMeters > 0) {
    for (const walk of findNearbyAccessWalks(
      topology.stops,
      destinationCode,
      originCode,
      maxDestWalkMeters,
    )) {
      destWalkByStop.set(walk.stopCode, {
        walkMeters: walk.distanceMeters,
        walkSeconds: walk.walkSeconds,
      });
    }
  }

  const sequences: LineSequence[] = [];
  for (const [key, stops] of Object.entries(topology.lineStops)) {
    if (stops.length < 2) {
      continue;
    }
    const [lineIdStr, dirStr] = key.split(':');
    const direction = Number(dirStr);
    const line = lineIdStr ? topology.lines[lineIdStr] : undefined;
    if (!line || !Number.isFinite(direction)) {
      continue;
    }
    if (!includeNight && /^A\d/i.test(line.label.trim())) {
      continue;
    }
    sequences.push({ line, direction, stops });
  }

  let previousLabels = new Map<string, RoundLabel>([
    [
      originCode,
      {
        estimatedArrival: 0,
        legs: [],
        transfers: [],
      },
    ],
  ]);

  if (maxOriginWalkMeters > 0) {
    for (const walk of findNearbyAccessWalks(
      topology.stops,
      originCode,
      destinationCode,
      maxOriginWalkMeters,
    )) {
      previousLabels.set(walk.stopCode, {
        estimatedArrival: walk.walkSeconds,
        legs: [],
        transfers: [],
        originWalk: {
          fromStopCode: originCode,
          toStopCode: walk.stopCode,
          walkMeters: walk.distanceMeters,
          walkSeconds: walk.walkSeconds,
        },
      });
    }
  }

  const collected = new Map<string, CandidateCorridor>();

  const recordCandidate = (corridor: CandidateCorridor): void => {
    const sig = corridorSignature(corridor);
    const existing = collected.get(sig);
    if (!existing || corridorScore(corridor) < corridorScore(existing)) {
      collected.set(sig, corridor);
    }
  };

  for (let round = 0; round <= maxTransfers; round++) {
    const boardingLabels = new Map<string, RoundLabel>();

    if (round === 0) {
      for (const [stopCode, label] of previousLabels) {
        boardingLabels.set(stopCode, label);
      }
    } else {
      for (const [stopCode, label] of previousLabels) {
        const sameStopTransfer: CorridorTransfer = {
          fromStopCode: stopCode,
          toStopCode: stopCode,
          walkMeters: 0,
          walkSeconds: 0,
          minTransferSeconds: DEFAULT_SAME_STOP_TRANSFER_SECONDS,
        };
        const candidateSame: RoundLabel = {
          estimatedArrival: label.estimatedArrival + DEFAULT_SAME_STOP_TRANSFER_SECONDS,
          legs: label.legs,
          transfers: label.transfers,
          originWalk: label.originWalk,
          pendingTransfer: sameStopTransfer,
        };
        const existingSame = boardingLabels.get(stopCode);
        if (!existingSame || roundLabelCost(candidateSame) < roundLabelCost(existingSame)) {
          boardingLabels.set(stopCode, candidateSame);
        }

        const walkNeighbors = walkMap.get(stopCode);
        if (walkNeighbors) {
          for (const walk of walkNeighbors) {
            const walkSeconds = walk.durationSeconds - DEFAULT_SAME_STOP_TRANSFER_SECONDS;
            const walkTransfer: CorridorTransfer = {
              fromStopCode: walk.fromStopCode,
              toStopCode: walk.toStopCode,
              walkMeters: walk.distanceMeters,
              walkSeconds,
              minTransferSeconds: walk.durationSeconds,
            };
            const candidateWalk: RoundLabel = {
              estimatedArrival: label.estimatedArrival + walk.durationSeconds,
              legs: label.legs,
              transfers: label.transfers,
              originWalk: label.originWalk,
              pendingTransfer: walkTransfer,
            };
            const existingWalk = boardingLabels.get(walk.toStopCode);
            if (!existingWalk || roundLabelCost(candidateWalk) < roundLabelCost(existingWalk)) {
              boardingLabels.set(walk.toStopCode, candidateWalk);
            }
          }
        }
      }
    }

    const nextLabels = new Map<string, RoundLabel>();

    for (const seq of sequences) {
      const { line, direction, stops } = seq;
      const len = stops.length;
      const passLength = line.isCircular ? len * 2 : len;

      const originIndices: number[] = [];
      const destIndices: number[] = [];
      for (let sIdx = 0; sIdx < len; sIdx++) {
        const sc = stops[sIdx]!.code;
        if (sc === originCode) {
          originIndices.push(sIdx);
        }
        if (sc === destinationCode) {
          destIndices.push(sIdx);
        }
      }

      let bestBoard: {
        label: RoundLabel;
        boardIdx: number;
        boardK: number;
        boardStop: LineStop;
      } | null = null;

      for (let k = 0; k < passLength; k++) {
        const idx = k % len;
        const currentStop = stops[idx]!;

        if (bestBoard !== null) {
          const stopsCount = k - bestBoard.boardK;
          if (stopsCount > 0 && stopsCount < len) {
            if (currentStop.code !== bestBoard.boardStop.code) {
              const isOriginWalkFirstLeg =
                bestBoard.label.legs.length === 0 && Boolean(bestBoard.label.originWalk);
              const redundantOriginWalk =
                isOriginWalkFirstLeg &&
                originIndices.some((originIdx) => {
                  if (!line.isCircular) {
                    return originIdx <= idx;
                  }
                  if (originIdx === idx) {
                    return true;
                  }
                  const originStopsCount = (idx - originIdx + len) % len;
                  return originStopsCount > 0 && originStopsCount <= stopsCount + 1;
                });

              if (!redundantOriginWalk) {
                const estDur = estimateLegDurationSeconds(
                  stops,
                  bestBoard.boardIdx,
                  idx,
                  line.isCircular,
                );
                const arrivalEst = bestBoard.label.estimatedArrival + estDur;
                const leg: CorridorLeg = {
                  lineId: line.id,
                  lineLabel: line.label,
                  lineColor: line.color,
                  direction,
                  isCircular: line.isCircular,
                  boardStopCode: bestBoard.boardStop.code,
                  alightStopCode: currentStop.code,
                  boardIdx: bestBoard.boardIdx,
                  alightIdx: idx,
                  stopsCount,
                  estimatedDurationSeconds: estDur,
                  isTerminusAlight: !line.isCircular && idx === len - 1,
                };
                const nextTransfers = bestBoard.label.pendingTransfer
                  ? [...bestBoard.label.transfers, bestBoard.label.pendingTransfer]
                  : bestBoard.label.transfers;
                const newLegs = [...bestBoard.label.legs, leg];

                if (currentStop.code === destinationCode) {
                  recordCandidate({
                    legs: newLegs,
                    transfers: nextTransfers,
                    ...(bestBoard.label.originWalk
                      ? { originWalk: bestBoard.label.originWalk }
                      : {}),
                    estimatedTotalSeconds: arrivalEst,
                  });
                } else {
                  const destWalk = destWalkByStop.get(currentStop.code);
                  if (destWalk) {
                    const redundantDestWalk = destIndices.some((destIdx) => {
                      if (!line.isCircular) {
                        return destIdx > bestBoard!.boardIdx;
                      }
                      if (destIdx === bestBoard!.boardIdx) {
                        return false;
                      }
                      const destStopsCount = (destIdx - bestBoard!.boardIdx + len) % len;
                      return destStopsCount > 0 && destStopsCount <= stopsCount + 1;
                    });
                    if (!redundantDestWalk) {
                      recordCandidate({
                        legs: newLegs,
                        transfers: nextTransfers,
                        ...(bestBoard.label.originWalk
                          ? { originWalk: bestBoard.label.originWalk }
                          : {}),
                        destinationWalk: {
                          fromStopCode: currentStop.code,
                          toStopCode: destinationCode,
                          walkMeters: destWalk.walkMeters,
                          walkSeconds: destWalk.walkSeconds,
                        },
                        estimatedTotalSeconds: arrivalEst + destWalk.walkSeconds,
                      });
                    }
                  }
                }

                const nextCandidate: RoundLabel = {
                  estimatedArrival: arrivalEst,
                  legs: newLegs,
                  transfers: nextTransfers,
                  ...(bestBoard.label.originWalk ? { originWalk: bestBoard.label.originWalk } : {}),
                };
                const existingBest = nextLabels.get(currentStop.code);
                if (!existingBest || roundLabelCost(nextCandidate) < roundLabelCost(existingBest)) {
                  nextLabels.set(currentStop.code, nextCandidate);
                }
              }
            }
          } else if (stopsCount >= len) {
            bestBoard = null;
          }
        }

        if (k < len) {
          const boardingLabel = boardingLabels.get(currentStop.code);
          if (boardingLabel) {
            const lastLeg = boardingLabel.legs[boardingLabel.legs.length - 1];
            const changesLine = !lastLeg || lastLeg.lineId !== line.id;
            if (changesLine) {
              const currentCostAtStop =
                bestBoard !== null
                  ? roundLabelCost(bestBoard.label) +
                    estimateLegDurationSeconds(stops, bestBoard.boardIdx, idx, line.isCircular)
                  : Number.POSITIVE_INFINITY;
              if (roundLabelCost(boardingLabel) < currentCostAtStop) {
                bestBoard = {
                  label: boardingLabel,
                  boardIdx: idx,
                  boardK: k,
                  boardStop: currentStop,
                };
              }
            }
          }
        }
      }
    }

    if (nextLabels.size === 0) {
      break;
    }
    previousLabels = nextLabels;
  }

  const all = Array.from(collected.values()).sort(
    (a, b) => corridorScore(a) - corridorScore(b) || a.transfers.length - b.transfers.length,
  );

  // Preserve direct corridors and cap additional transfer corridors to bound schedule fetches.
  const direct = all.filter((c) => c.transfers.length === 0);
  const transfers = all.filter((c) => c.transfers.length > 0);

  if (direct.length >= maxCorridors) {
    return direct.slice(0, maxCorridors);
  }
  const transferLimit =
    direct.length > 0 ? Math.min(2, maxCorridors - direct.length) : maxCorridors - direct.length;
  return [...direct, ...transfers.slice(0, transferLimit)];
}

/**
 * Checks offline if allowing origin/destination walks (`<= 200 m`, e.g. opposite sidewalk)
 * yields a direct route or saves at least 5 minutes compared to `baselineCorridors`.
 */
export function findAlternativeWalkSuggestion(
  topology: NetworkTopology,
  originCode: string,
  destinationCode: string,
  baselineCorridors: readonly CandidateCorridor[],
  options: CorridorSearchOptions = {},
): RouteWalkSuggestion | undefined {
  const altCorridors = findCandidateCorridors(topology, originCode, destinationCode, {
    ...options,
    maxOriginWalkMeters: Math.max(DEFAULT_ORIGIN_WALK_METERS, options.maxOriginWalkMeters ?? 0),
    maxDestWalkMeters: Math.max(DEFAULT_DEST_WALK_METERS, options.maxDestWalkMeters ?? 0),
  });

  const bestAlt = altCorridors[0];
  if (!bestAlt || (!bestAlt.originWalk && !bestAlt.destinationWalk)) {
    return undefined;
  }

  const bestBase = baselineCorridors[0];
  const savesEnoughTime =
    bestBase !== undefined && bestBase.estimatedTotalSeconds - bestAlt.estimatedTotalSeconds >= 300;
  const reducesTransfers =
    bestBase !== undefined && bestAlt.transfers.length < bestBase.transfers.length;

  if (bestBase !== undefined && !savesEnoughTime && !reducesTransfers) {
    return undefined;
  }

  const originWalk = bestAlt.originWalk;
  const destWalk = bestAlt.destinationWalk;
  const type: RouteWalkSuggestion['type'] =
    originWalk && destWalk ? 'both' : originWalk ? 'origin' : 'destination';

  return {
    type,
    walkMeters: (originWalk?.walkMeters ?? 0) + (destWalk?.walkMeters ?? 0),
    walkSeconds: (originWalk?.walkSeconds ?? 0) + (destWalk?.walkSeconds ?? 0),
    ...(originWalk
      ? {
          suggestedOriginStopCode: originWalk.toStopCode,
          suggestedOriginStopName:
            topology.stops[originWalk.toStopCode]?.name || originWalk.toStopCode,
        }
      : {}),
    ...(destWalk
      ? {
          suggestedDestStopCode: destWalk.fromStopCode,
          suggestedDestStopName:
            topology.stops[destWalk.fromStopCode]?.name || destWalk.fromStopCode,
        }
      : {}),
    lineLabels: bestAlt.legs.map((leg) => leg.lineLabel),
    estimatedDurationSeconds: bestAlt.estimatedTotalSeconds,
    baselineDurationSeconds: bestBase ? bestBase.estimatedTotalSeconds : null,
    transfers: bestAlt.transfers.length,
    baselineTransfers: bestBase ? bestBase.transfers.length : null,
  };
}
