import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { TussamError, TussamValidationError } from './api/errors.js';
import { selectStopFrom } from './cli/selectStop.js';
import {
  formatAlerts,
  formatArrivalsTable,
  formatCacheStatus,
  formatLineRoute,
  formatLinesTable,
  formatNearbyTable,
  formatStopScheduleTable,
  formatTimetable,
} from './format/tables.js';
import { Tussam, findMatchingLine } from './tussam.js';
import {
  formatDateKey,
  isSameLocalDay,
  parseAfterOption,
  resolveQueryDate,
} from './utils/time.js';

function parseIntegerOption(value: string, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new TussamValidationError(`Invalid ${label} '${value}'. Expected an integer.`);
  }
  return Number.parseInt(value.trim(), 10);
}

function parseNumberArg(value: string, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new TussamValidationError(`Invalid ${label} '${value}'. Expected a number.`);
  }
  return num;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNearbyArgv(argv: string[]): string[] {
  const nearbyIdx = argv.findIndex((arg, idx) => idx >= 2 && arg === 'nearby');
  if (nearbyIdx === -1) {
    return argv;
  }
  const rest = argv.slice(nearbyIdx + 1);
  if (rest.includes('--')) {
    return argv;
  }

  const valueFlags = new Set(['-r', '--radius', '-n', '--limit']);
  const flags: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (valueFlags.has(token)) {
      flags.push(token);
      if (i + 1 < rest.length) {
        flags.push(rest[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--radius=') || token.startsWith('--limit=')) {
      flags.push(token);
      continue;
    }
    if (/^-\d+(\.\d+)?$/.test(token) || !token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    flags.push(token);
  }

  if (positionals.length === 0) {
    return argv;
  }
  return [...argv.slice(0, nearbyIdx + 1), ...flags, '--', ...positionals];
}

async function runRootRouteCommand(opts: {
  from?: string;
  to?: string;
  day?: string;
  month?: string;
  year?: string;
  sort?: boolean;
  after?: string;
  limit?: string;
  all?: boolean;
  maxTransfers?: string;
  walk?: string;
  night?: boolean;
  live?: boolean;
  refresh?: boolean;
  json?: boolean;
}): Promise<void> {
  if (!opts.from || !opts.to) {
    throw new TussamValidationError('Both -f <origin> and -t <destination> are required for timetable search.');
  }

  const now = new Date();
  const date = resolveQueryDate(
    {
      day: opts.day !== undefined ? parseIntegerOption(opts.day, 'day') : undefined,
      month: opts.month !== undefined ? parseIntegerOption(opts.month, 'month') : undefined,
      year: opts.year !== undefined ? parseIntegerOption(opts.year, 'year') : undefined,
    },
    now,
  );

  const maxTransfers =
    opts.maxTransfers !== undefined ? parseIntegerOption(opts.maxTransfers, 'max-transfers') : 2;
  if (maxTransfers < 0 || maxTransfers > 3) {
    throw new TussamValidationError('max-transfers must be between 0 and 3.');
  }

  const maxWalkMeters = opts.walk !== undefined ? parseIntegerOption(opts.walk, 'walk') : 300;
  if (maxWalkMeters < 0) {
    throw new TussamValidationError('walk distance must be non-negative.');
  }

  const limit = opts.limit !== undefined ? parseIntegerOption(opts.limit, 'limit') : 15;
  if (limit < 1) {
    throw new TussamValidationError('limit must be at least 1.');
  }

  const afterSeconds = opts.after
    ? parseAfterOption(opts.after)
    : isSameLocalDay(date, now)
      ? now.getHours() * 3600 + now.getMinutes() * 60
      : undefined;

  const tussam = new Tussam();
  const originMatches = await tussam.matchStops(opts.from, { refresh: Boolean(opts.refresh) });
  const origin = await selectStopFrom(opts.from, originMatches);

  const destMatches = await tussam.matchStops(opts.to);
  const destination = await selectStopFrom(opts.to, destMatches);

  const { journeys } = await tussam.findSchedules({
    fromStopCode: origin.code,
    toStopCode: destination.code,
    date,
    sortByDuration: Boolean(opts.sort),
    afterSeconds,
    maxTransfers,
    maxWalkMeters,
    includeNight: Boolean(opts.night),
    refresh: Boolean(opts.refresh),
    onSyncProgress: (done, total, label) => {
      if (process.stderr.isTTY) {
        process.stderr.write(`\rSyncing TUSSAM network topology (${done}/${total}): ${label.padEnd(28)}`);
        if (done === total) {
          process.stderr.write('\n');
        }
      } else if (done === 1) {
        process.stderr.write(`Syncing TUSSAM network topology (${total} route directions)...\n`);
      }
    },
  });

  const displayed = opts.all ? journeys : journeys.slice(0, limit);
  const liveArrivals = opts.live ? await tussam.getStopArrivals(origin.code) : undefined;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          date: formatDateKey(date),
          origin,
          destination,
          totalJourneys: journeys.length,
          journeys: displayed,
          ...(liveArrivals ? { liveArrivals } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`Today is: ${formatDateKey(now)}\n`);
  process.stdout.write(`Searching timetable for date: ${formatDateKey(date)}\n`);
  process.stdout.write(`Origin stop: ${origin.name} (#${origin.code})\n`);
  process.stdout.write(`Destination stop: ${destination.name} (#${destination.code})\n`);
  process.stdout.write(
    `${formatTimetable(displayed, {
      totalCount: journeys.length,
      limited: !opts.all && journeys.length > displayed.length,
    })}\n`,
  );

  if (liveArrivals) {
    process.stdout.write(`${formatArrivalsTable(liveArrivals)}\n`);
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('tussam-cli')
    .description('Fast CLI and TypeScript library for TUSSAM Seville bus timetables and real-time arrivals')
    .version(pkg.version, '-V, --version', 'Print version information')
    .enablePositionalOptions()
    .option('-f, --from <origin>', 'Set origin stop (code or name)')
    .option('-t, --to <destination>', 'Set destination stop (code or name)')
    .option('-d, --day <day>', 'Set the day (default: today)')
    .option('-m, --month <month>', 'Set the month (default: today)')
    .option('-y, --year <year>', 'Set the year (default: today)')
    .option('-s, --sort', 'Sort timetable by duration')
    .option('--after <HH:MM>', 'Show departures at or after HH:MM')
    .option('--limit <n>', 'Maximum journeys to display', '15')
    .option('--all', 'Show all journeys for the full day')
    .option('--max-transfers <n>', 'Maximum number of transfers (0-3)', '2')
    .option('--walk <meters>', 'Maximum walking distance for transfers in meters', '300')
    .option('--night', 'Include night lines (A1-A8)')
    .option('--live', 'Also display live arrival estimates at the origin stop')
    .option('--refresh', 'Force refresh of cached network topology and schedules')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      if (!opts.from && !opts.to) {
        program.outputHelp();
        return;
      }
      await runRootRouteCommand(opts);
    });

  program
    .command('stop <query>')
    .description('Show live bus arrivals (or scheduled passing times with --schedule) for a stop')
    .option('-l, --line <label>', 'Filter by line label (e.g. 01, C4)')
    .option('-w, --watch [seconds]', 'Refresh live arrivals continuously (min 10s, default 15s)')
    .option('--schedule', 'Show full scheduled passing times instead of live arrivals')
    .option('-d, --day <day>', 'Set the day (with --schedule)')
    .option('-m, --month <month>', 'Set the month (with --schedule)')
    .option('-y, --year <year>', 'Set the year (with --schedule)')
    .option('--no-cache', 'Bypass fresh arrival cache')
    .option('--json', 'Output JSON')
    .action(async (query: string, opts) => {
      const rootOpts = program.opts<{ day?: string; month?: string; year?: string; json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const tussam = new Tussam();
      const trimmedQuery = query.trim();
      const isNumericCode = /^\d+$/.test(trimmedQuery);

      if (!opts.schedule && isNumericCode) {
        if (opts.watch !== undefined) {
          const intervalSec =
            typeof opts.watch === 'string'
              ? Math.max(10, parseIntegerOption(opts.watch, 'watch'))
              : 15;
          let running = true;
          const onSigInt = (): void => {
            running = false;
          };
          process.once('SIGINT', onSigInt);

          try {
            while (running) {
              const arrivals = await tussam.getStopArrivals(trimmedQuery, { noCache: true });
              if (useJson) {
                process.stdout.write(`${JSON.stringify(arrivals)}\n`);
              } else {
                if (process.stdout.isTTY) {
                  process.stdout.write('\x1Bc');
                }
                process.stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
                process.stdout.write(`\nRefreshing every ${intervalSec}s (Ctrl+C to stop)...\n`);
              }
              if (!running) {
                break;
              }
              await sleep(intervalSec * 1_000);
            }
          } finally {
            process.off('SIGINT', onSigInt);
          }
          return;
        }

        const arrivals = await tussam.getStopArrivals(trimmedQuery, { noCache: opts.cache === false });
        if (useJson) {
          process.stdout.write(`${JSON.stringify(arrivals, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
        return;
      }

      const matches = await tussam.matchStops(query);
      const stop = await selectStopFrom(query, matches);

      if (opts.schedule) {
        const date = resolveQueryDate({
          day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
          month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
          year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
        });
        const allLines = await tussam.getLines(date, { all: true });
        const targetLines = opts.line
          ? [findMatchingLine(allLines, opts.line)].filter((l): l is NonNullable<typeof l> => Boolean(l))
          : stop.lines
              .map((ref) => allLines.find((l) => l.id === ref.lineId))
              .filter((l): l is NonNullable<typeof l> => Boolean(l));

        if (opts.line && targetLines.length === 0) {
          throw new TussamValidationError(`Unknown TUSSAM line '${opts.line}'.`);
        }

        const entries: Array<{ lineLabel: string; times: string[] }> = [];
        for (const line of targetLines) {
          const times = await tussam.getStopSchedule(stop.code, line.label, date);
          entries.push({ lineLabel: line.label, times });
        }

        if (useJson) {
          process.stdout.write(
            `${JSON.stringify({ stop, date: formatDateKey(date), schedules: entries }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${formatStopScheduleTable(stop.code, stop.name, entries, formatDateKey(date))}\n`,
        );
        return;
      }

      if (opts.watch !== undefined) {
        const intervalSec =
          typeof opts.watch === 'string' ? Math.max(10, parseIntegerOption(opts.watch, 'watch')) : 15;
        let running = true;
        const onSigInt = (): void => {
          running = false;
        };
        process.once('SIGINT', onSigInt);

        try {
          while (running) {
            const arrivals = await tussam.getStopArrivals(stop.code, { noCache: true });
            if (useJson) {
              process.stdout.write(`${JSON.stringify(arrivals)}\n`);
            } else {
              if (process.stdout.isTTY) {
                process.stdout.write('\x1Bc');
              }
              process.stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
              process.stdout.write(`\nRefreshing every ${intervalSec}s (Ctrl+C to stop)...\n`);
            }
            if (!running) {
              break;
            }
            await sleep(intervalSec * 1_000);
          }
        } finally {
          process.off('SIGINT', onSigInt);
        }
        return;
      }

      const arrivals = await tussam.getStopArrivals(stop.code, { noCache: opts.cache === false });
      if (useJson) {
        process.stdout.write(`${JSON.stringify(arrivals, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
    });

  program
    .command('lines')
    .description('List active TUSSAM bus and tram lines')
    .option('-d, --day <day>', 'Set the day')
    .option('-m, --month <month>', 'Set the month')
    .option('-y, --year <year>', 'Set the year')
    .option('--night', 'Show night lines (01:30)')
    .option('--all', 'Show both daytime and night lines')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const rootOpts = program.opts<{ day?: string; month?: string; year?: string; json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const date = resolveQueryDate({
        day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
        month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
        year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
      });
      const tussam = new Tussam();
      const lines = await tussam.getLines(date, {
        night: Boolean(opts.night),
        all: Boolean(opts.all),
      });

      if (useJson) {
        process.stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatLinesTable(lines)}\n`);
    });

  program
    .command('line <label>')
    .description('Show ordered stops and schedule bounds for a TUSSAM line')
    .option('--direction <dir>', 'Filter direction: 1, 2, or both', 'both')
    .option('-d, --day <day>', 'Set the day')
    .option('-m, --month <month>', 'Set the month')
    .option('-y, --year <year>', 'Set the year')
    .option('--json', 'Output JSON')
    .action(async (label: string, opts) => {
      const rootOpts = program.opts<{ day?: string; month?: string; year?: string; json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const direction = String(opts.direction ?? 'both');
      if (direction !== '1' && direction !== '2' && direction !== 'both') {
        throw new TussamValidationError(`Invalid direction '${direction}'. Expected 1, 2, or both.`);
      }
      const date = resolveQueryDate({
        day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
        month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
        year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
      });

      const tussam = new Tussam();
      const route = await tussam.getLineRoute(label, date);

      if (useJson) {
        process.stdout.write(`${JSON.stringify(route, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatLineRoute(route, direction)}\n`);
    });

  program
    .command('nearby <lat> <lon>')
    .description('Find TUSSAM stops near GPS coordinates')
    .option('-r, --radius <meters>', 'Search radius in meters', '500')
    .option('-n, --limit <count>', 'Maximum stops to return', '10')
    .option('--arrivals', 'Fetch live arrivals for the top 3 closest stops')
    .option('--json', 'Output JSON')
    .action(async (latArg: string, lonArg: string, opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);

      const lat = parseNumberArg(latArg, 'latitude');
      const lon = parseNumberArg(lonArg, 'longitude');
      const radius = parseIntegerOption(String(opts.radius ?? '500'), 'radius');
      const limit = parseIntegerOption(String(opts.limit ?? '10'), 'limit');

      const tussam = new Tussam();
      const stops = await tussam.getNearbyStops(lat, lon, {
        radius,
        limit,
        withArrivals: Boolean(opts.arrivals),
      });

      if (useJson) {
        process.stdout.write(`${JSON.stringify(stops, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatNearbyTable(stops)}\n`);
    });

  program
    .command('alerts')
    .description('Show active TUSSAM service notifications and detours')
    .option('-l, --line <label>', 'Filter alerts affecting a specific line')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);

      const tussam = new Tussam();
      const alerts = await tussam.getActiveAlerts(opts.line);

      if (useJson) {
        process.stdout.write(`${JSON.stringify(alerts, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatAlerts(alerts)}\n`);
    });

  program
    .command('cache <action>')
    .description('Inspect, sync, or clear the local cache (status | sync | clear)')
    .option('--night', 'Include night lines when running sync')
    .option('--json', 'Output JSON')
    .action(async (action: string, opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);

      const tussam = new Tussam();
      const normalized = action.trim().toLowerCase();

      if (normalized === 'status') {
        const status = await tussam.getCacheStatus();
        if (useJson) {
          process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${formatCacheStatus(status)}\n`);
        return;
      }

      if (normalized === 'sync') {
        const topology = await tussam.syncCache({
          includeNight: Boolean(opts.night),
          force: true,
          onProgress: (done, total, label) => {
            if (process.stderr.isTTY) {
              process.stderr.write(`\rSyncing TUSSAM topology (${done}/${total}): ${label.padEnd(28)}`);
              if (done === total) {
                process.stderr.write('\n');
              }
            } else if (done === 1) {
              process.stderr.write(`Syncing TUSSAM topology (${total} route directions)...\n`);
            }
          },
        });
        const summary = {
          syncedAt: topology.syncedAt,
          includesNight: topology.includesNight,
          linesCount: Object.keys(topology.lines).length,
          stopsCount: Object.keys(topology.stops).length,
        };
        if (useJson) {
          process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `Synced ${summary.linesCount} lines and ${summary.stopsCount} stops to local cache.\n`,
        );
        return;
      }

      if (normalized === 'clear') {
        await tussam.clearCache();
        if (useJson) {
          process.stdout.write(`${JSON.stringify({ cleared: true })}\n`);
          return;
        }
        process.stdout.write('Cleared local tussam-cli cache.\n');
        return;
      }

      throw new TussamValidationError(
        `Unknown cache action '${action}'. Expected status, sync, or clear.`,
      );
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(normalizeNearbyArgv(argv));
  } catch (err) {
    if (err instanceof TussamError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

void runCli();
