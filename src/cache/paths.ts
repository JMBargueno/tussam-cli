import os from 'node:os';
import path from 'node:path';

export const CACHE_DIR_ENV_VAR = 'TUSSAM_CLI_CACHE_DIR';

/**
 * Resolves the local cache directory, honoring `TUSSAM_CLI_CACHE_DIR` if set.
 */
export function getCacheDir(): string {
  const override = process.env[CACHE_DIR_ENV_VAR]?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'tussam-cli', 'cache');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'tussam-cli');
  }

  const xdgCache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(xdgCache, 'tussam-cli');
}
