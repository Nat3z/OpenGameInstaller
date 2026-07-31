/**
 * Platform-related utility functions
 */
import { PlatformError } from '@ogi/errors';
import * as fs from 'fs';
import { basename, join } from 'path';
import { findSteamCompatDataPath } from '@/electron/lib/steam-installation.js';
import { __dirname } from '@/electron/manager/manager.paths.js';

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

export function getCompatDataDir(steamAppId?: number): string {
  const compatDataPath = findSteamCompatDataPath(steamAppId);
  if (compatDataPath) return compatDataPath;
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new PlatformError({
      message: 'Home directory not found',
      platform: process.platform,
    });
  }
  return `${homeDir}/.steam/steam/steamapps/compatdata`;
}

export function getProtonPrefixPath(steamAppId: number): string {
  return `${getCompatDataDir(steamAppId)}/${steamAppId}/pfx`;
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
