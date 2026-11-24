export interface StopLineRef {
  lineId: number;
  label: string;
  color: string;
}

export interface Stop {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  lines: StopLineRef[];
  icons?: string[];
}

export interface LineDirectionInfo {
  direction: number;
  destination: string;
  startTime: string;
  endTime: string;
}

export interface Line {
  id: number;
  label: string;
  subline: number | null;
  description: string;
  color: string;
  isCircular: boolean;
  directions: LineDirectionInfo[];
}

export interface LineStop {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  distanceMeters: number;
  startTime: string | null;
  endTime: string | null;
  icons: string[];
}

export interface NetworkTopology {
  schemaVersion: 1;
  syncedAt: string;
  includesNight: boolean;
  lines: Record<string, Line>;
  stops: Record<string, Stop>;
  lineStops: Record<string, LineStop[]>;
}

export interface StopArrival {
  lineId: number;
  lineLabel: string;
  color: string;
  destination: string;
  seconds: number;
  minutes: number;
  distanceMeters: number | null;
  vehicle: number | null;
  attributes: string[];
}

export interface StopArrivalsResult {
  stopCode: string;
  stopName: string;
  lat: number | null;
  lon: number | null;
  fetchedAt: string;
  stale: boolean;
  arrivals: StopArrival[];
}

export interface NearbyStop {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  distanceMeters: number;
  lines: StopLineRef[];
  arrivals?: StopArrivalsResult;
}

export interface ServiceAlert {
  id: number | string;
  createdAt: string;
  expiresAt: string;
  lines: string[];
  content: string;
  type: string;
}

export interface WalkTransfer {
  fromStopCode: string;
  toStopCode: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface JourneyLeg {
  lineId: number;
  lineLabel: string;
  lineColor: string;
  direction: number;
  fromStopCode: string;
  fromStopName: string;
  toStopCode: string;
  toStopName: string;
  departureSeconds: number;
  arrivalSeconds: number;
  stopsCount: number;
  estimated: boolean;
}

export interface JourneyTransfer {
  fromStopCode: string;
  fromStopName: string;
  toStopCode: string;
  toStopName: string;
  walkMeters: number;
  walkSeconds: number;
  arrivalSeconds: number;
  departureSeconds: number;
  waitSeconds: number;
}

export interface Journey {
  legs: JourneyLeg[];
  transfers: JourneyTransfer[];
  departureSeconds: number;
  arrivalSeconds: number;
  durationSeconds: number;
  transferCount: number;
  estimated: boolean;
}

export interface RouteSearchOptions {
  fromStopCode: string;
  toStopCode: string;
  date?: Date;
  sortByDuration?: boolean;
  afterSeconds?: number;
  maxTransfers?: number;
  maxWalkMeters?: number;
  includeNight?: boolean;
  refresh?: boolean;
}

export interface CacheStatus {
  cacheDir: string;
  stopIndex: {
    present: boolean;
    fresh: boolean;
    count: number;
    updatedAt: string | null;
  };
  topology: {
    present: boolean;
    fresh: boolean;
    includesNight: boolean;
    linesCount: number;
    stopsCount: number;
    syncedAt: string | null;
  };
  schedulesCount: number;
  arrivalsCount: number;
  totalBytes: number;
}

export type SyncProgressCallback = (done: number, total: number, label: string) => void;
