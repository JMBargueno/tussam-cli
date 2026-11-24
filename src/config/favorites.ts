import fs from 'node:fs/promises';
import path from 'node:path';
import { TussamError, TussamValidationError } from '../api/errors.js';
import type { FavoriteStop, Stop } from '../types.js';
import { getConfigDir } from './paths.js';

interface FavoritesFile {
  schemaVersion: 1;
  favorites: Record<string, FavoriteStop>;
}

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Validates and normalizes a favorite stop alias (lowercase, 1-32 chars, non-numeric).
 */
export function normalizeFavoriteAlias(alias: string): string {
  const cleaned = alias.trim().toLowerCase();
  if (!cleaned) {
    throw new TussamValidationError('Favorite alias cannot be empty.');
  }
  if (/^\d+$/.test(cleaned)) {
    throw new TussamValidationError(
      `Favorite alias '${cleaned}' cannot be purely numeric because numeric queries represent stop codes.`,
    );
  }
  if (!ALIAS_PATTERN.test(cleaned)) {
    throw new TussamValidationError(
      `Invalid favorite alias '${alias}'. Use 1-32 letters, digits, '-' or '_', starting with a letter or digit.`,
    );
  }
  return cleaned;
}

export interface FavoritesStoreOptions {
  configDir?: string;
  nowFn?: () => number;
}

export class FavoritesStore {
  readonly configDir: string;
  private readonly nowFn: () => number;

  constructor(options: FavoritesStoreOptions | string = {}) {
    if (typeof options === 'string') {
      this.configDir = path.resolve(options);
      this.nowFn = Date.now;
    } else {
      this.configDir = path.resolve(options.configDir ?? getConfigDir());
      this.nowFn = options.nowFn ?? Date.now;
    }
  }

  private get filePath(): string {
    return path.join(this.configDir, 'favorites.json');
  }

  private async readStore(): Promise<Record<string, FavoriteStop>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {};
      }
      throw new TussamError(
        `Unable to read favorites file '${this.filePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: Partial<FavoritesFile> | null;
    try {
      parsed = JSON.parse(raw) as Partial<FavoritesFile> | null;
    } catch (err) {
      throw new TussamError(
        `Favorites file '${this.filePath}' contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (parsed?.schemaVersion !== 1 || !parsed.favorites || typeof parsed.favorites !== 'object') {
      throw new TussamError(`Favorites file '${this.filePath}' has an unrecognized schema.`);
    }
    return parsed.favorites;
  }

  private async writeStore(favorites: Record<string, FavoriteStop>): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const payload: FavoritesFile = {
      schemaVersion: 1,
      favorites,
    };
    const tmpPath = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async list(): Promise<FavoriteStop[]> {
    const favorites = await this.readStore();
    return Object.values(favorites).sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async get(alias: string): Promise<FavoriteStop | null> {
    const normalized = normalizeFavoriteAlias(alias);
    const favorites = await this.readStore();
    return favorites[normalized] ?? null;
  }

  async add(alias: string, stop: Pick<Stop, 'code' | 'name'>): Promise<FavoriteStop> {
    const normalized = normalizeFavoriteAlias(alias);
    const favorites = await this.readStore();
    const entry: FavoriteStop = {
      alias: normalized,
      stopCode: stop.code,
      stopName: stop.name,
      addedAt: new Date(this.nowFn()).toISOString(),
    };
    favorites[normalized] = entry;
    await this.writeStore(favorites);
    return entry;
  }

  async remove(alias: string): Promise<boolean> {
    const normalized = normalizeFavoriteAlias(alias);
    const favorites = await this.readStore();
    if (!Object.hasOwn(favorites, normalized)) {
      return false;
    }
    delete favorites[normalized];
    await this.writeStore(favorites);
    return true;
  }

  async resolveAlias(query: string): Promise<FavoriteStop | null> {
    const cleaned = query.trim().toLowerCase();
    if (!cleaned || /^\d+$/.test(cleaned) || !ALIAS_PATTERN.test(cleaned)) {
      return null;
    }
    const favorites = await this.readStore();
    return favorites[cleaned] ?? null;
  }
}
