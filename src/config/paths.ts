import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_ENV_VAR = 'TUSSAM_CLI_CONFIG_DIR';

/**
 * Resolves the local user config directory, honoring `TUSSAM_CLI_CONFIG_DIR` if set.
 */
export function getConfigDir(): string {
  const override = process.env[CONFIG_DIR_ENV_VAR]?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'tussam-cli');
  }

  if (process.platform === 'darwin') {
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    if (xdg) {
      return path.join(xdg, 'tussam-cli');
    }
    return path.join(os.homedir(), 'Library', 'Application Support', 'tussam-cli');
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'tussam-cli');
}
