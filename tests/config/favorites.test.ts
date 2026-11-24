import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TussamError, TussamValidationError } from '../../src/api/errors.js';
import { FavoritesStore, normalizeFavoriteAlias } from '../../src/config/favorites.js';
import { CONFIG_DIR_ENV_VAR, getConfigDir } from '../../src/config/paths.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tussam-fav-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env[CONFIG_DIR_ENV_VAR];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('FavoritesStore & config paths', () => {
  it('honors TUSSAM_CLI_CONFIG_DIR environment variable', () => {
    process.env[CONFIG_DIR_ENV_VAR] = './custom-config-dir';
    expect(getConfigDir()).toBe(path.resolve('./custom-config-dir'));
  });

  it('validates aliases and rejects purely numeric or invalid names', () => {
    expect(normalizeFavoriteAlias(' Casa ')).toBe('casa');
    expect(normalizeFavoriteAlias('work_2-stop')).toBe('work_2-stop');
    expect(() => normalizeFavoriteAlias('')).toThrow(TussamValidationError);
    expect(() => normalizeFavoriteAlias('43')).toThrow(TussamValidationError);
    expect(() => normalizeFavoriteAlias('bad alias!')).toThrow(TussamValidationError);
  });

  it('persists, lists, resolves, and removes favorite stops atomically', async () => {
    const dir = await makeTempDir();
    const fixedNow = Date.parse('2026-11-24T12:00:00.000Z');
    const store = new FavoritesStore({ configDir: dir, nowFn: () => fixedNow });

    expect(await store.list()).toEqual([]);

    await store.add('Trabajo', { code: '58', name: 'Manuel Siurot (Hospital V.Rocio)' });
    await store.add('casa', { code: '43', name: 'Recaredo (Puerta Carmona)' });

    const reloaded = new FavoritesStore({ configDir: dir });
    const list = await reloaded.list();
    expect(list.map((f) => f.alias)).toEqual(['casa', 'trabajo']);
    expect(await reloaded.get('CASA')).toEqual({
      alias: 'casa',
      stopCode: '43',
      stopName: 'Recaredo (Puerta Carmona)',
      addedAt: '2026-11-24T12:00:00.000Z',
    });

    // Arbitrarily spaced queries return null without throwing
    expect(await reloaded.resolveAlias('puerta carmona')).toBeNull();
    expect(await reloaded.resolveAlias('43')).toBeNull();
    expect((await reloaded.resolveAlias('trabajo'))?.stopCode).toBe('58');

    expect(await reloaded.remove('casa')).toBe(true);
    expect(await reloaded.remove('casa')).toBe(false);
    expect((await reloaded.list()).map((f) => f.alias)).toEqual(['trabajo']);
  });

  it('throws TussamError instead of silently wiping a corrupt favorites file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'favorites.json'), '{not valid json', 'utf8');
    const store = new FavoritesStore({ configDir: dir });

    await expect(store.list()).rejects.toThrow(TussamError);
    await expect(store.add('casa', { code: '43', name: 'Recaredo' })).rejects.toThrow(TussamError);
  });
});
