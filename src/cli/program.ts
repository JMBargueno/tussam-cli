import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { TussamApiError, TussamError, TussamValidationError } from '../api/errors.js';
import { FavoritesStore } from '../config/favorites.js';
import {
  formatAlerts,
  formatArrivalsTable,
  formatCacheStatus,
  formatFavoritesTable,
  formatLineRoute,
  formatLinesTable,
  formatNearbyTable,
  formatStopScheduleTable,
  formatTimetable,
  formatWalkSuggestion,
} from '../format/tables.js';
import { DEFAULT_DEST_WALK_METERS, DEFAULT_ORIGIN_WALK_METERS } from '../routing/transfers.js';
import { Tussam, findMatchingLine } from '../tussam.js';
import type { Stop } from '../types.js';
import {
  formatDateKey,
  isSameLocalDay,
  parseAfterOption,
  resolveQueryDate,
} from '../utils/time.js';
import { generateCompletionScript } from './completions.js';
import { runInteractivePrompt } from './interactive.js';
import { selectStopFrom } from './selectStop.js';
import { watchStopArrivals } from './watch.js';

export interface CliContext {
  createTussam?: () => Tussam;
  favoritesStore?: FavoritesStore;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  nowFn?: () => Date;
  configureExitOverride?: boolean;
  manageProcessExitCode?: boolean;
}

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

const ROOT_VALUE_OPTIONS = new Set([
  '-f',
  '--from',
  '-t',
  '--to',
  '-d',
  '--day',
  '-m',
  '--month',
  '-y',
  '--year',
  '--after',
  '--limit',
  '--max-transfers',
  '--walk',
  '--origin-walk',
  '--dest-walk',
]);

export function normalizeNearbyArgv(argv: string[]): string[] {
  let nearbyIdx = -1;
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      break;
    }
    if (ROOT_VALUE_OPTIONS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    if (token === 'nearby') {
      nearbyIdx = i;
    }
    break;
  }

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
    if (
      token.startsWith('--radius=') ||
      token.startsWith('--limit=') ||
      token.startsWith('-r=') ||
      token.startsWith('-n=')
    ) {
      flags.push(token);
      continue;
    }
    if (/^-(\d+(\.\d+)?|\.\d+)$/.test(token) || !token.startsWith('-')) {
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

function isInteractiveTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as { isTTY?: boolean }).isTTY);
}

function writeSyncProgress(
  stderr: NodeJS.WritableStream,
  prefix: string,
  done: number,
  total: number,
  label: string,
): void {
  if (isInteractiveTty(stderr)) {
    stderr.write(`\r${prefix} (${done}/${total}): ${label.padEnd(28)}`);
    if (done === total) {
      stderr.write('\n');
    }
  } else if (done === 1) {
    stderr.write(`${prefix} (${total} steps)...\n`);
  }
}

async function resolveStopQuery(
  tussam: Tussam,
  favorites: FavoritesStore,
  query: string,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  options: { refresh?: boolean } = {},
): Promise<Stop> {
  const fav = await favorites.resolveAlias(query);
  if (fav) {
    const matches = await tussam.matchStops(fav.stopCode, options);
    if (matches.length > 0) {
      return matches[0]!;
    }
    return {
      code: fav.stopCode,
      name: fav.stopName,
      lat: null,
      lon: null,
      lines: [],
    };
  }

  const matches = await tussam.matchStops(query, options);
  return selectStopFrom(query, matches, stdin, stdout);
}

interface RouteCommandOptions {
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
  originWalk?: string;
  destWalk?: string;
  night?: boolean;
  live?: boolean;
  refresh?: boolean;
  estimate?: boolean;
  interactive?: boolean;
  json?: boolean;
}

function parseValidatedRouteParams(opts: RouteCommandOptions, now: Date) {
  const maxTransfers =
    opts.maxTransfers !== undefined ? parseIntegerOption(opts.maxTransfers, 'max-transfers') : 2;
  if (maxTransfers < 0 || maxTransfers > 3) {
    throw new TussamValidationError('max-transfers must be between 0 and 3.');
  }

  const maxWalkMeters = opts.walk !== undefined ? parseIntegerOption(opts.walk, 'walk') : 300;
  if (maxWalkMeters < 0) {
    throw new TussamValidationError('walk distance must be non-negative.');
  }

  const maxOriginWalkMeters =
    opts.originWalk !== undefined
      ? parseIntegerOption(opts.originWalk, 'origin-walk')
      : DEFAULT_ORIGIN_WALK_METERS;
  if (maxOriginWalkMeters < 0) {
    throw new TussamValidationError('origin-walk distance must be non-negative.');
  }

  const maxDestWalkMeters =
    opts.destWalk !== undefined
      ? parseIntegerOption(opts.destWalk, 'dest-walk')
      : DEFAULT_DEST_WALK_METERS;
  if (maxDestWalkMeters < 0) {
    throw new TussamValidationError('dest-walk distance must be non-negative.');
  }

  const limit = opts.limit !== undefined ? parseIntegerOption(opts.limit, 'limit') : 15;
  if (limit < 1) {
    throw new TussamValidationError('limit must be at least 1.');
  }

  const date = resolveQueryDate(
    {
      day: opts.day !== undefined ? parseIntegerOption(opts.day, 'day') : undefined,
      month: opts.month !== undefined ? parseIntegerOption(opts.month, 'month') : undefined,
      year: opts.year !== undefined ? parseIntegerOption(opts.year, 'year') : undefined,
    },
    now,
  );

  const afterSeconds = opts.after
    ? parseAfterOption(opts.after)
    : isSameLocalDay(date, now)
      ? now.getHours() * 3600 + now.getMinutes() * 60
      : undefined;

  return {
    maxTransfers,
    maxWalkMeters,
    maxOriginWalkMeters,
    maxDestWalkMeters,
    limit,
    date,
    afterSeconds,
  };
}

async function executeRouteSearch(
  tussam: Tussam,
  origin: Stop,
  destination: Stop,
  params: {
    date: Date;
    now: Date;
    sortByDuration: boolean;
    afterSeconds?: number;
    maxTransfers: number;
    maxWalkMeters: number;
    maxOriginWalkMeters: number;
    maxDestWalkMeters: number;
    limit: number;
    all: boolean;
    night: boolean;
    live: boolean;
    refresh: boolean;
    estimate: boolean;
    json: boolean;
  },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  const result = await tussam.findSchedules({
    fromStopCode: origin.code,
    toStopCode: destination.code,
    date: params.date,
    sortByDuration: params.sortByDuration,
    afterSeconds: params.afterSeconds,
    maxTransfers: params.maxTransfers,
    maxWalkMeters: params.maxWalkMeters,
    maxOriginWalkMeters: params.maxOriginWalkMeters,
    maxDestWalkMeters: params.maxDestWalkMeters,
    includeNight: params.night,
    refresh: params.refresh,
    estimate: params.estimate,
    onSyncProgress: (done, total, label) =>
      writeSyncProgress(stderr, 'Syncing TUSSAM network topology', done, total, label),
  });

  const displayed = params.all ? result.journeys : result.journeys.slice(0, params.limit);
  const liveArrivals = params.live ? await tussam.getStopArrivals(origin.code) : undefined;

  if (params.json) {
    stdout.write(
      `${JSON.stringify(
        {
          date: formatDateKey(params.date),
          origin,
          destination,
          totalJourneys: result.journeys.length,
          journeys: displayed,
          rateLimited: result.rateLimited,
          partial: result.partial,
          estimatedFallback: result.estimatedFallback,
          warnings: result.warnings,
          ...(result.walkSuggestion ? { walkSuggestion: result.walkSuggestion } : {}),
          ...(liveArrivals ? { liveArrivals } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  for (const warning of result.warnings) {
    stderr.write(`[WARN] ${warning}\n`);
  }

  stdout.write(`Today is: ${formatDateKey(params.now)}\n`);
  stdout.write(`Searching timetable for date: ${formatDateKey(params.date)}\n`);
  stdout.write(`Origin stop: ${origin.name} (#${origin.code})\n`);
  stdout.write(`Destination stop: ${destination.name} (#${destination.code})\n`);
  stdout.write(
    `${formatTimetable(displayed, {
      totalCount: result.journeys.length,
      limited: !params.all && result.journeys.length > displayed.length,
      estimatedFallback: result.estimatedFallback,
    })}\n`,
  );

  if (result.walkSuggestion) {
    stdout.write(`\n${formatWalkSuggestion(result.walkSuggestion)}\n`);
  }

  if (liveArrivals) {
    stdout.write(`${formatArrivalsTable(liveArrivals)}\n`);
  }
}

export function createProgram(ctx: CliContext = {}): Command {
  const createTussam = ctx.createTussam ?? (() => new Tussam());
  const favorites = ctx.favoritesStore ?? new FavoritesStore();
  const stdin = ctx.stdin ?? process.stdin;
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const nowFn = ctx.nowFn ?? (() => new Date());

  const program = new Command();

  program
    .name('tussam-cli')
    .description(
      'Fast CLI and TypeScript library for TUSSAM Seville bus timetables and real-time arrivals',
    )
    .version(pkg.version, '-V, --version', 'Print version information')
    .enablePositionalOptions()
    .option('-f, --from <origin>', 'Set origin stop (code, name, or favorite)')
    .option('-t, --to <destination>', 'Set destination stop (code, name, or favorite)')
    .option('-d, --day <day>', 'Set the day (default: today)')
    .option('-m, --month <month>', 'Set the month (default: today)')
    .option('-y, --year <year>', 'Set the year (default: today)')
    .option('-s, --sort', 'Sort timetable by duration')
    .option('--after <HH:MM>', 'Show departures at or after HH:MM')
    .option('--limit <n>', 'Maximum journeys to display', '15')
    .option('--all', 'Show all journeys for the full day')
    .option('--max-transfers <n>', 'Maximum number of transfers (0-3)', '2')
    .option('--walk <meters>', 'Maximum walking distance for transfers in meters', '300')
    .option(
      '--origin-walk <meters>',
      'Maximum initial walking distance to a nearby stop in meters',
      String(DEFAULT_ORIGIN_WALK_METERS),
    )
    .option(
      '--dest-walk <meters>',
      'Maximum final walking distance from a nearby stop in meters',
      String(DEFAULT_DEST_WALK_METERS),
    )
    .option('--night', 'Include night lines (A1-A8)')
    .option('--live', 'Also display live arrival estimates at the origin stop')
    .option('--refresh', 'Force refresh of cached network topology and schedules')
    .option(
      '--estimate',
      'Use offline topology-based route estimates without querying TUSSAM schedule APIs',
    )
    .option('-i, --interactive', 'Launch interactive step-by-step route search')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: RouteCommandOptions) => {
      const now = nowFn();

      if (opts.interactive) {
        const parsed = parseValidatedRouteParams(opts, now);
        const tussam = createTussam();
        const promptResult = await runInteractivePrompt({
          matchStops: (query) => tussam.matchStops(query, { refresh: Boolean(opts.refresh) }),
          resolveFavorite: (query) => favorites.resolveAlias(query),
          listFavorites: () => favorites.list(),
          input: stdin,
          output: stdout,
          now,
        });

        await executeRouteSearch(
          tussam,
          promptResult.origin,
          promptResult.destination,
          {
            date: promptResult.date,
            now,
            sortByDuration: Boolean(opts.sort ?? promptResult.sortByDuration),
            afterSeconds: opts.after ? parsed.afterSeconds : promptResult.afterSeconds,
            maxTransfers: parsed.maxTransfers,
            maxWalkMeters: parsed.maxWalkMeters,
            maxOriginWalkMeters: parsed.maxOriginWalkMeters,
            maxDestWalkMeters: parsed.maxDestWalkMeters,
            limit: parsed.limit,
            all: Boolean(opts.all),
            night: Boolean(opts.night),
            live: Boolean(opts.live),
            refresh: Boolean(opts.refresh),
            estimate: Boolean(opts.estimate),
            json: Boolean(opts.json),
          },
          stdout,
          stderr,
        );
        return;
      }

      if (!opts.from && !opts.to) {
        program.outputHelp();
        return;
      }
      if (!opts.from || !opts.to) {
        throw new TussamValidationError(
          'Both -f <origin> and -t <destination> are required for timetable search.',
        );
      }

      const parsed = parseValidatedRouteParams(opts, now);
      const tussam = createTussam();
      const origin = await resolveStopQuery(tussam, favorites, opts.from, stdin, stdout, {
        refresh: Boolean(opts.refresh),
      });
      const destination = await resolveStopQuery(tussam, favorites, opts.to, stdin, stdout);

      await executeRouteSearch(
        tussam,
        origin,
        destination,
        {
          date: parsed.date,
          now,
          sortByDuration: Boolean(opts.sort),
          afterSeconds: parsed.afterSeconds,
          maxTransfers: parsed.maxTransfers,
          maxWalkMeters: parsed.maxWalkMeters,
          maxOriginWalkMeters: parsed.maxOriginWalkMeters,
          maxDestWalkMeters: parsed.maxDestWalkMeters,
          limit: parsed.limit,
          all: Boolean(opts.all),
          night: Boolean(opts.night),
          live: Boolean(opts.live),
          refresh: Boolean(opts.refresh),
          estimate: Boolean(opts.estimate),
          json: Boolean(opts.json),
        },
        stdout,
        stderr,
      );
    });

  program
    .command('interactive')
    .description('Launch interactive step-by-step route search')
    .option('--limit <n>', 'Maximum journeys to display', '15')
    .option('--all', 'Show all journeys for the full day')
    .option('--max-transfers <n>', 'Maximum number of transfers (0-3)', '2')
    .option('--walk <meters>', 'Maximum walking distance for transfers in meters', '300')
    .option(
      '--origin-walk <meters>',
      'Maximum initial walking distance to a nearby stop in meters',
      String(DEFAULT_ORIGIN_WALK_METERS),
    )
    .option(
      '--dest-walk <meters>',
      'Maximum final walking distance from a nearby stop in meters',
      String(DEFAULT_DEST_WALK_METERS),
    )
    .option('--night', 'Include night lines (A1-A8)')
    .option('--live', 'Also display live arrival estimates at the origin stop')
    .option('--refresh', 'Force refresh of cached network topology and schedules')
    .option('--estimate', 'Use offline topology-based route estimates')
    .option('--json', 'Output JSON')
    .action(async (opts: RouteCommandOptions) => {
      const rootOpts = program.opts<{ json?: boolean; estimate?: boolean; night?: boolean }>();
      const now = nowFn();
      const parsed = parseValidatedRouteParams(opts, now);
      const tussam = createTussam();

      const promptResult = await runInteractivePrompt({
        matchStops: (query) => tussam.matchStops(query, { refresh: Boolean(opts.refresh) }),
        resolveFavorite: (query) => favorites.resolveAlias(query),
        listFavorites: () => favorites.list(),
        input: stdin,
        output: stdout,
        now,
      });

      await executeRouteSearch(
        tussam,
        promptResult.origin,
        promptResult.destination,
        {
          date: promptResult.date,
          now,
          sortByDuration: promptResult.sortByDuration,
          afterSeconds: promptResult.afterSeconds,
          maxTransfers: parsed.maxTransfers,
          maxWalkMeters: parsed.maxWalkMeters,
          maxOriginWalkMeters: parsed.maxOriginWalkMeters,
          maxDestWalkMeters: parsed.maxDestWalkMeters,
          limit: parsed.limit,
          all: Boolean(opts.all),
          night: Boolean(opts.night ?? rootOpts.night),
          live: Boolean(opts.live),
          refresh: Boolean(opts.refresh),
          estimate: Boolean(opts.estimate ?? rootOpts.estimate),
          json: Boolean(opts.json ?? rootOpts.json),
        },
        stdout,
        stderr,
      );
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
      const rootOpts = program.opts<{
        day?: string;
        month?: string;
        year?: string;
        json?: boolean;
      }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const tussam = createTussam();
      const trimmedQuery = query.trim();
      const fav = await favorites.resolveAlias(trimmedQuery);
      const directStopCode = fav ? fav.stopCode : /^\d+$/.test(trimmedQuery) ? trimmedQuery : null;

      if (!opts.schedule && directStopCode) {
        if (opts.watch !== undefined) {
          const intervalSec =
            typeof opts.watch === 'string'
              ? Math.max(10, parseIntegerOption(opts.watch, 'watch'))
              : 15;
          await watchStopArrivals({
            stopCode: directStopCode,
            fetchArrivals: () => tussam.getStopArrivals(directStopCode, { noCache: true }),
            intervalSec,
            filterLine: opts.line,
            useJson,
            stdout,
            stderr,
            nowFn,
          });
          return;
        }

        const arrivals = await tussam.getStopArrivals(directStopCode, {
          noCache: opts.cache === false,
        });
        if (useJson) {
          stdout.write(`${JSON.stringify(arrivals, null, 2)}\n`);
          return;
        }
        stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
        return;
      }

      const stop = await resolveStopQuery(tussam, favorites, query, stdin, stdout);

      if (opts.schedule) {
        const date = resolveQueryDate(
          {
            day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
            month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
            year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
          },
          nowFn(),
        );
        const allLines = await tussam.getLines(date, { all: true });
        const targetLines = opts.line
          ? [findMatchingLine(allLines, opts.line)].filter((l): l is NonNullable<typeof l> =>
              Boolean(l),
            )
          : stop.lines
              .map((ref) => allLines.find((l) => l.id === ref.lineId))
              .filter((l): l is NonNullable<typeof l> => Boolean(l));

        if (opts.line && targetLines.length === 0) {
          throw new TussamValidationError(`Unknown TUSSAM line '${opts.line}'.`);
        }

        const entries: Array<{ lineLabel: string; lineColor: string; times: string[] }> = [];
        for (const line of targetLines) {
          const times = await tussam.getStopSchedule(stop.code, line.label, date);
          entries.push({ lineLabel: line.label, lineColor: line.color, times });
        }

        if (useJson) {
          stdout.write(
            `${JSON.stringify({ stop, date: formatDateKey(date), schedules: entries }, null, 2)}\n`,
          );
          return;
        }
        stdout.write(
          `${formatStopScheduleTable(stop.code, stop.name, entries, formatDateKey(date))}\n`,
        );
        return;
      }

      if (opts.watch !== undefined) {
        const intervalSec =
          typeof opts.watch === 'string'
            ? Math.max(10, parseIntegerOption(opts.watch, 'watch'))
            : 15;
        await watchStopArrivals({
          stopCode: stop.code,
          fetchArrivals: () => tussam.getStopArrivals(stop.code, { noCache: true }),
          intervalSec,
          filterLine: opts.line,
          useJson,
          stdout,
          stderr,
          nowFn,
        });
        return;
      }

      const arrivals = await tussam.getStopArrivals(stop.code, { noCache: opts.cache === false });
      if (useJson) {
        stdout.write(`${JSON.stringify(arrivals, null, 2)}\n`);
        return;
      }
      stdout.write(`${formatArrivalsTable(arrivals, opts.line)}\n`);
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
      const rootOpts = program.opts<{
        day?: string;
        month?: string;
        year?: string;
        json?: boolean;
      }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const date = resolveQueryDate(
        {
          day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
          month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
          year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
        },
        nowFn(),
      );
      const tussam = createTussam();
      const lines = await tussam.getLines(date, {
        night: Boolean(opts.night),
        all: Boolean(opts.all),
      });

      if (useJson) {
        stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
        return;
      }
      stdout.write(`${formatLinesTable(lines)}\n`);
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
      const rootOpts = program.opts<{
        day?: string;
        month?: string;
        year?: string;
        json?: boolean;
      }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const dayOpt = opts.day ?? rootOpts.day;
      const monthOpt = opts.month ?? rootOpts.month;
      const yearOpt = opts.year ?? rootOpts.year;

      const direction = String(opts.direction ?? 'both');
      if (direction !== '1' && direction !== '2' && direction !== 'both') {
        throw new TussamValidationError(
          `Invalid direction '${direction}'. Expected 1, 2, or both.`,
        );
      }
      const date = resolveQueryDate(
        {
          day: dayOpt !== undefined ? parseIntegerOption(dayOpt, 'day') : undefined,
          month: monthOpt !== undefined ? parseIntegerOption(monthOpt, 'month') : undefined,
          year: yearOpt !== undefined ? parseIntegerOption(yearOpt, 'year') : undefined,
        },
        nowFn(),
      );

      const tussam = createTussam();
      const route = await tussam.getLineRoute(label, date);

      if (useJson) {
        stdout.write(`${JSON.stringify(route, null, 2)}\n`);
        return;
      }
      stdout.write(`${formatLineRoute(route, direction)}\n`);
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

      const tussam = createTussam();
      const stops = await tussam.getNearbyStops(lat, lon, {
        radius,
        limit,
        withArrivals: Boolean(opts.arrivals),
      });

      if (useJson) {
        stdout.write(`${JSON.stringify(stops, null, 2)}\n`);
        return;
      }
      stdout.write(`${formatNearbyTable(stops)}\n`);
    });

  program
    .command('alerts')
    .description('Show active TUSSAM service notifications and detours')
    .option('-l, --line <label>', 'Filter alerts affecting a specific line')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);

      const tussam = createTussam();
      const alerts = await tussam.getActiveAlerts(opts.line);

      if (useJson) {
        stdout.write(`${JSON.stringify(alerts, null, 2)}\n`);
        return;
      }
      stdout.write(`${formatAlerts(alerts)}\n`);
    });

  program
    .command('fav <action> [alias] [stop...]')
    .description('Manage saved favorite stop aliases (add | rm | list)')
    .option('--json', 'Output JSON')
    .action(async (action: string, alias: string | undefined, stopParts: string[], opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);
      const normalizedAction = action.trim().toLowerCase();

      if (normalizedAction === 'list' || normalizedAction === 'ls') {
        const list = await favorites.list();
        if (useJson) {
          stdout.write(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        stdout.write(`${formatFavoritesTable(list)}\n`);
        return;
      }

      if (normalizedAction === 'add') {
        if (!alias) {
          throw new TussamValidationError('Usage: tussam-cli fav add <alias> <stop>');
        }
        const stopQuery = stopParts.join(' ').trim();
        if (!stopQuery) {
          throw new TussamValidationError('Usage: tussam-cli fav add <alias> <stop>');
        }
        const tussam = createTussam();
        const matches = await tussam.matchStops(stopQuery);
        const stop = await selectStopFrom(stopQuery, matches, stdin, stdout);
        const saved = await favorites.add(alias, stop);
        if (useJson) {
          stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
          return;
        }
        stdout.write(
          `Saved favorite '${saved.alias}' -> ${saved.stopName} (#${saved.stopCode}).\n`,
        );
        return;
      }

      if (normalizedAction === 'rm' || normalizedAction === 'remove') {
        if (!alias) {
          throw new TussamValidationError('Usage: tussam-cli fav rm <alias>');
        }
        const removed = await favorites.remove(alias);
        if (!removed) {
          throw new TussamValidationError(`Favorite '${alias}' does not exist.`);
        }
        if (useJson) {
          stdout.write(`${JSON.stringify({ removed: true, alias: alias.trim().toLowerCase() })}\n`);
          return;
        }
        stdout.write(`Removed favorite '${alias.trim().toLowerCase()}'.\n`);
        return;
      }

      throw new TussamValidationError(`Unknown fav action '${action}'. Expected add, rm, or list.`);
    });

  program
    .command('completion [shell]')
    .aliases(['completions'])
    .description('Generate shell completion script (bash | zsh | fish | powershell)')
    .action((shell?: string) => {
      if (!shell) {
        throw new TussamValidationError(
          'Missing shell argument. Expected one of: bash, zsh, fish, powershell.',
        );
      }
      stdout.write(generateCompletionScript(shell));
    });

  program
    .command('cache <action>')
    .description('Inspect, sync, or clear the local cache (status | sync | clear)')
    .option('--night', 'Include night lines when running sync')
    .option('--json', 'Output JSON')
    .action(async (action: string, opts) => {
      const rootOpts = program.opts<{ json?: boolean }>();
      const useJson = Boolean(opts.json ?? rootOpts.json);

      const tussam = createTussam();
      const normalized = action.trim().toLowerCase();

      if (normalized === 'status') {
        const status = await tussam.getCacheStatus();
        if (useJson) {
          stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        stdout.write(`${formatCacheStatus(status)}\n`);
        return;
      }

      if (normalized === 'sync') {
        const topology = await tussam.syncCache({
          includeNight: Boolean(opts.night),
          force: true,
          onProgress: (done, total, label) =>
            writeSyncProgress(stderr, 'Syncing TUSSAM topology', done, total, label),
        });
        const summary = {
          syncedAt: topology.syncedAt,
          includesNight: topology.includesNight,
          linesCount: Object.keys(topology.lines).length,
          stopsCount: Object.keys(topology.stops).length,
        };
        if (useJson) {
          stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
          return;
        }
        stdout.write(
          `Synced ${summary.linesCount} lines and ${summary.stopsCount} stops to local cache.\n`,
        );
        return;
      }

      if (normalized === 'clear') {
        await tussam.clearCache();
        if (useJson) {
          stdout.write(`${JSON.stringify({ cleared: true })}\n`);
          return;
        }
        stdout.write('Cleared local tussam-cli cache.\n');
        return;
      }

      throw new TussamValidationError(
        `Unknown cache action '${action}'. Expected status, sync, or clear.`,
      );
    });

  if (ctx.stdout || ctx.stderr) {
    program.configureOutput({
      writeOut: (str) => {
        stdout.write(str);
      },
      writeErr: (str) => {
        stderr.write(str);
      },
    });
  }

  if (ctx.configureExitOverride) {
    program.exitOverride();
  }

  return program;
}

export async function runCli(argv: string[] = process.argv, ctx: CliContext = {}): Promise<number> {
  const stderr = ctx.stderr ?? process.stderr;
  const manageExitCode = ctx.manageProcessExitCode !== false;
  const program = createProgram(ctx);

  try {
    await program.parseAsync(normalizeNearbyArgv(argv));
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (manageExitCode && err.exitCode !== 0) {
        process.exitCode = err.exitCode;
      }
      return err.exitCode;
    }

    if (err instanceof TussamApiError && err.statusCode === 429) {
      const hint = err.message.includes('--estimate')
        ? ''
        : ' Pass --estimate for offline topology estimates.';
      stderr.write(`Error: ${err.message}${hint}\n`);
    } else if (err instanceof TussamError) {
      stderr.write(`Error: ${err.message}\n`);
    } else {
      stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    if (manageExitCode) {
      process.exitCode = 1;
    }
    return 1;
  }
}
