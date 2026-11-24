import { TussamValidationError } from '../api/errors.js';

const SECONDS_PER_DAY = 86_400;
const WRAP_THRESHOLD_SECONDS = 6 * 3_600;

function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0');
}

/**
 * Formats a Date into TUSSAM's path parameter format: `DD-MM-YYYYTHH%3AMM%3ASS`.
 */
export function formatTussamDateTime(date: Date): string {
  const day = pad2(date.getDate());
  const month = pad2(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${day}-${month}-${year}T${hours}%3A${minutes}%3A${seconds}`;
}

/**
 * Formats a Date as `YYYY-MM-DD` in local wall-clock time.
 */
export function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Returns a Date on the same calendar day at a fixed local time.
 */
export function withLocalTime(date: Date, hours: number, minutes = 0, seconds = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, seconds, 0);
}

/**
 * Resolves and validates optional day/month/year CLI options against `now`.
 */
export function resolveQueryDate(
  params: { day?: number; month?: number; year?: number },
  now: Date = new Date(),
): Date {
  const day = params.day ?? now.getDate();
  const month = params.month ?? now.getMonth() + 1;
  const year = params.year ?? now.getFullYear();

  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    throw new TussamValidationError(`Invalid year '${year}'. Expected an integer between 1970 and 2100.`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new TussamValidationError(`Invalid month '${month}'. Expected an integer between 1 and 12.`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new TussamValidationError(`Invalid day '${day}'. Expected an integer between 1 and 31.`);
  }

  const resolved = new Date(
    year,
    month - 1,
    day,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    0,
  );

  if (
    resolved.getFullYear() !== year ||
    resolved.getMonth() !== month - 1 ||
    resolved.getDate() !== day
  ) {
    throw new TussamValidationError(`Provided date '${year}-${pad2(month)}-${pad2(day)}' does not exist.`);
  }

  return resolved;
}

/**
 * Parses `HH:MM` or `HH:MM:SS` into seconds since midnight, or `null` for `"-"` / invalid text.
 */
export function parseClockToSeconds(clock: string | null | undefined): number | null {
  if (!clock) {
    return null;
  }
  const trimmed = clock.trim();
  if (!trimmed || trimmed === '-') {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] !== undefined ? Number(match[3]) : 0;
  if (hours < 0 || hours > 47 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Validates and parses a strict `HH:MM` CLI `--after` filter into seconds since midnight.
 */
export function parseAfterOption(hhmm: string): number {
  const trimmed = hhmm.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new TussamValidationError(`Invalid time '${hhmm}'. Expected HH:MM format (e.g. 08:30).`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new TussamValidationError(`Invalid time '${hhmm}'. Hours must be 00-23 and minutes 00-59.`);
  }
  return hours * 3600 + minutes * 60;
}

/**
 * Converts a TUSSAM schedule string array into monotonically increasing service seconds,
 * handling after-midnight rollovers (e.g. `23:51:25` followed by `00:06:29`).
 */
export function normalizeScheduleSeconds(rawTimes: readonly string[]): number[] {
  const result: number[] = [];
  let dayOffset = 0;
  let previous: number | null = null;

  for (const raw of rawTimes) {
    const parsed = parseClockToSeconds(raw);
    if (parsed === null) {
      continue;
    }

    let adjusted = parsed + dayOffset;
    while (previous !== null && adjusted < previous - WRAP_THRESHOLD_SECONDS) {
      dayOffset += SECONDS_PER_DAY;
      adjusted = parsed + dayOffset;
    }

    result.push(adjusted);
    previous = adjusted;
  }

  return result;
}

/**
 * Formats seconds since service start as `HH:MM` wrapped to a 24-hour clock.
 */
export function formatSecondsToHHMM(seconds: number): string {
  const wrapped = ((Math.floor(seconds) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hours = Math.floor(wrapped / 3600);
  const minutes = Math.floor((wrapped % 3600) / 60);
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Formats a non-negative duration in seconds as `HH:MM`.
 */
export function formatDurationHHMM(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Checks if two Date instances share the same local calendar day.
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
