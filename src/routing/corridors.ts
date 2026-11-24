import type { Line, LineStop, NetworkTopology } from '../types.js';
import { estimateLegDurationSeconds } from './scheduleMatcher.js';
import {
  buildWalkTransferMap,
  DEFAULT_MAX_WALK_METERS,
  DEFAULT_SAME_STOP_TRANSFER_SECONDS,
  DEFAULT_TRANSFER_PENALTY_SECONDS,
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
}

export interface CorridorTransfer {
  fromStopCode: string;
  toStopCode: string;
  walkMeters: number;
  walkSeconds: number;
  minTransferSeconds: number;
}

export interface CandidateCorridor {
  legs: CorridorLeg[];
  transfers: CorridorTransfer[];
  estimatedTotalSeconds: number;
}

interface CorridorSearchOptions {
  maxTransfers?: number;
  maxWalkMeters?: number;
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
  pendingTransfer?: CorridorTransfer;
}

function corridorSignature(legs: readonly CorridorLeg[]): string {
  return legs
    .map((l) => `${l.lineId}:${l.direction}:${l.boardStopCode}->${l.alightStopCode}`)
    .join('|');
}

function corridorScore(corridor: CandidateCorridor): number {
  return corridor.estimatedTotalSeconds + corridor.transfers.length * DEFAULT_TRANSFER_PENALTY_SECONDS;
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
  const maxCorridors = Math.max(1, options.maxCorridors ?? 6);
  const includeNight = Boolean(options.includeNight);

  const walkMap = maxTransfers > 0 ? buildWalkTransferMap(topology.stops, maxWalkMeters) : new Map();

  const sequences: LineSequence[] = [];
  for (const [key, stops] of Object.entries(topology.lineStops)) {
    if (stops.length < 2) {
      continue;
    }
    const [lineIdStr, dirStr] = key.split(':');
    const lineId = Number(lineIdStr);
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

  const collected = new Map<string, CandidateCorridor>();

  const recordCandidate = (corridor: CandidateCorridor): void => {
    const sig = corridorSignature(corridor.legs);
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
          pendingTransfer: sameStopTransfer,
        };
        const existingSame = boardingLabels.get(stopCode);
        if (!existingSame || candidateSame.estimatedArrival < existingSame.estimatedArrival) {
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
              pendingTransfer: walkTransfer,
            };
            const existingWalk = boardingLabels.get(walk.toStopCode);
            if (!existingWalk || candidateWalk.estimatedArrival < existingWalk.estimatedArrival) {
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
            };
            const nextTransfers = bestBoard.label.pendingTransfer
              ? [...bestBoard.label.transfers, bestBoard.label.pendingTransfer]
              : bestBoard.label.transfers;
            const newLegs = [...bestBoard.label.legs, leg];

            if (currentStop.code === destinationCode) {
              recordCandidate({
                legs: newLegs,
                transfers: nextTransfers,
                estimatedTotalSeconds: arrivalEst,
              });
            }

            const existingBest = nextLabels.get(currentStop.code);
            if (!existingBest || arrivalEst < existingBest.estimatedArrival) {
              nextLabels.set(currentStop.code, {
                estimatedArrival: arrivalEst,
                legs: newLegs,
                transfers: nextTransfers,
              });
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
                  ? bestBoard.label.estimatedArrival +
                    estimateLegDurationSeconds(stops, bestBoard.boardIdx, idx, line.isCircular)
                  : Number.POSITIVE_INFINITY;
              if (boardingLabel.estimatedArrival < currentCostAtStop) {
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
