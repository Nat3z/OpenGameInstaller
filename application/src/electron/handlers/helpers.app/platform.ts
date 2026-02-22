/**
 * Platform-related utility functions
 */
import * as fs from 'fs';
import { join, basename } from 'path';
import { __dirname } from '../../manager/manager.paths.js';

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function getHomeDir(): string | null {
  return process.env.HOME || process.env.USERPROFILE || null;
}

/** Current OS username (e.g. "deck" on Steam Deck). */
export function getCurrentUsername(): string | null {
  if (process.env.USER) return process.env.USER;
  const home = getHomeDir();
  return home ? basename(home) : null;
}

export function getCompatDataDir(): string {
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new Error('Home directory not found');
  }
  return `${homeDir}/.steam/steam/steamapps/compatdata`;
}

export function getProtonPrefixPath(steamAppId: number): string {
  const compatDataDir = getCompatDataDir();
  return `${compatDataDir}/${steamAppId}/pfx`;
}

/**
 * Get the path to the OGI executable for hook-based launches (Steam, desktop shortcuts).
 * Returns APPIMAGE env if set, else packaged AppImage path if it exists, else process.execPath.
 */
export function getOgiExecutablePath(): string {
  if (process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  const packagedPath = join(__dirname, '../../OpenGameInstaller.AppImage');
  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }
  return process.execPath;
}
