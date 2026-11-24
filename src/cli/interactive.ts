import readline from 'node:readline';
import { TussamValidationError } from '../api/errors.js';
import type { FavoriteStop, Stop } from '../types.js';
import { isSameLocalDay, parseAfterOption, resolveQueryDate } from '../utils/time.js';
import { selectStopWithReader } from './selectStop.js';

export interface InteractivePromptOptions {
  matchStops: (query: string) => Promise<Stop[]>;
  resolveFavorite?: (query: string) => Promise<FavoriteStop | null>;
  listFavorites?: () => Promise<FavoriteStop[]>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  now?: Date;
}

export interface InteractivePromptResult {
  origin: Stop;
  destination: Stop;
  date: Date;
  afterSeconds?: number;
  sortByDuration: boolean;
}

function parseInteractiveDate(raw: string, now: Date): Date {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'today') {
    return new Date(now.getTime());
  }
  if (trimmed === 'tomorrow') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
  }

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    return resolveQueryDate(
      {
        year: Number.parseInt(isoMatch[1]!, 10),
        month: Number.parseInt(isoMatch[2]!, 10),
        day: Number.parseInt(isoMatch[3]!, 10),
      },
      now,
    );
  }

  const dmyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    return resolveQueryDate(
      {
        day: Number.parseInt(dmyMatch[1]!, 10),
        month: Number.parseInt(dmyMatch[2]!, 10),
        year: Number.parseInt(dmyMatch[3]!, 10),
      },
      now,
    );
  }

  throw new TussamValidationError(
    `Invalid date '${raw}'. Use YYYY-MM-DD, DD/MM/YYYY, 'today', or 'tomorrow'.`,
  );
}

/**
 * Runs an interactive step-by-step route search prompt using a single readline interface.
 */
export async function runInteractivePrompt(
  options: InteractivePromptOptions,
): Promise<InteractivePromptResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const now = options.now ?? new Date();

  const favorites = options.listFavorites ? await options.listFavorites() : [];
  if (favorites.length > 0) {
    const hints = favorites.map((f) => `${f.alias} (#${f.stopCode})`).join(', ');
    output.write(`Saved favorites: ${hints}\n`);
  }

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  const iterator = rl[Symbol.asyncIterator]();

  const readLine = async (): Promise<string | null> => {
    const next = await iterator.next();
    return next.done ? null : next.value;
  };

  const ask = async (prompt: string): Promise<string> => {
    output.write(prompt);
    const line = await readLine();
    if (line === null) {
      throw new TussamValidationError('Interactive route search cancelled.');
    }
    return line;
  };

  const promptStop = async (label: string): Promise<Stop> => {
    while (true) {
      const query = (await ask(`${label} stop (code, name, or favorite): `)).trim();
      if (!query) {
        output.write('Please enter a stop code, stop name, or favorite alias.\n');
        continue;
      }

      if (options.resolveFavorite) {
        const fav = await options.resolveFavorite(query);
        if (fav) {
          const favMatches = await options.matchStops(fav.stopCode);
          if (favMatches.length > 0) {
            return favMatches[0]!;
          }
          return {
            code: fav.stopCode,
            name: fav.stopName,
            lat: null,
            lon: null,
            lines: [],
          };
        }
      }

      const matches = await options.matchStops(query);
      if (matches.length === 0) {
        output.write(`No stops matched '${query}'. Try another code or name.\n`);
        continue;
      }

      if (matches.length === 1) {
        return matches[0]!;
      }

      return selectStopWithReader(query, matches, readLine, output);
    }
  };

  try {
    const origin = await promptStop('Origin');
    const destination = await promptStop('Destination');

    let date: Date;
    while (true) {
      const rawDate = await ask("Date [YYYY-MM-DD, 'today', 'tomorrow', Enter for today]: ");
      try {
        date = parseInteractiveDate(rawDate, now);
        break;
      } catch (err) {
        output.write(`${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    let afterSeconds: number | undefined;
    while (true) {
      const rawAfter = (await ask('Depart after [HH:MM, Enter for default]: ')).trim();
      if (!rawAfter) {
        afterSeconds = isSameLocalDay(date, now)
          ? now.getHours() * 3600 + now.getMinutes() * 60
          : undefined;
        break;
      }
      try {
        afterSeconds = parseAfterOption(rawAfter);
        break;
      } catch (err) {
        output.write(`${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    const rawSort = (await ask('Sort by duration? [y/N]: ')).trim();
    const sortByDuration = /^(y|yes|s|si)$/i.test(rawSort);

    return {
      origin,
      destination,
      date,
      afterSeconds,
      sortByDuration,
    };
  } finally {
    rl.close();
  }
}
