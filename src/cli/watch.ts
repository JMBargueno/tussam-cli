import { formatArrivalsTable } from '../format/tables.js';
import type { StopArrivalsResult } from '../types.js';

export interface WatchStopOptions {
  stopCode: string;
  fetchArrivals: () => Promise<StopArrivalsResult>;
  intervalSec: number;
  filterLine?: string;
  useJson?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  isTTY?: boolean;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowFn?: () => Date;
  signal?: AbortSignal;
  maxIterations?: number;
}

function defaultAbortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatClockHMS(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Watches live arrivals with clean TTY redraws, last-updated timestamp, 1s countdown,
 * and immediate SIGINT/AbortSignal cancellation.
 */
export async function watchStopArrivals(options: WatchStopOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isTTY =
    options.isTTY ?? (Boolean((stdout as { isTTY?: boolean }).isTTY) && !options.useJson);
  const sleepFn = options.sleepFn ?? defaultAbortableSleep;
  const nowFn = options.nowFn ?? (() => new Date());
  const intervalSec = Math.max(1, Math.round(options.intervalSec));

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      return;
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const onSigInt = (): void => {
    controller.abort();
  };
  process.once('SIGINT', onSigInt);

  let cursorHidden = false;
  let iterations = 0;

  try {
    while (!controller.signal.aborted) {
      let frameText: string | null = null;
      let warnText: string | null = null;

      try {
        const arrivals = await options.fetchArrivals();
        if (controller.signal.aborted) {
          break;
        }
        if (options.useJson) {
          frameText = `${JSON.stringify(arrivals)}\n`;
        } else {
          frameText = `${formatArrivalsTable(arrivals, options.filterLine)}\n\nLast updated: ${formatClockHMS(nowFn())}\n`;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        warnText = `[WARN] Refresh failed for stop #${options.stopCode}: ${message}\n`;
      }

      if (isTTY && !options.useJson) {
        const prefix = !cursorHidden ? '\x1b[?25l\x1b[2J\x1b[H' : '\x1b[H\x1b[J';
        cursorHidden = true;
        if (frameText !== null) {
          stdout.write(prefix + frameText);
        } else if (warnText !== null) {
          stdout.write(`${prefix}\n${warnText}`);
        }
      } else {
        if (frameText !== null) {
          stdout.write(frameText);
        } else if (warnText !== null) {
          if (options.useJson) {
            stderr.write(warnText);
          } else {
            stdout.write(`\n${warnText}`);
          }
        }
      }

      iterations += 1;
      if (options.maxIterations !== undefined && iterations >= options.maxIterations) {
        break;
      }

      if (isTTY && !options.useJson) {
        for (
          let remaining = intervalSec;
          remaining > 0 && !controller.signal.aborted;
          remaining--
        ) {
          stdout.write(`\r\x1b[KNext refresh in ${remaining}s (Ctrl+C to stop)...`);
          await sleepFn(1_000, controller.signal);
        }
      } else {
        if (!options.useJson) {
          stdout.write(`Refreshing every ${intervalSec}s (Ctrl+C to stop)...\n`);
        }
        await sleepFn(intervalSec * 1_000, controller.signal);
      }
    }
  } finally {
    process.off('SIGINT', onSigInt);
    options.signal?.removeEventListener('abort', onExternalAbort);
    if (cursorHidden) {
      stdout.write('\r\x1b[K\x1b[?25h\n');
    }
  }
}
