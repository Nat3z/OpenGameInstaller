/**
 * Platform-related utility functions
 */

/**
 * Returns true when the current platform is Linux.
 *
 * @returns true if process.platform is 'linux'
 */
export function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Returns the user's home directory path, or null if not set.
 *
 * @returns HOME or USERPROFILE env value, or null
 */
export function getHomeDir(): string | null {
  return process.env.HOME || process.env.USERPROFILE || null;
}

/**
 * Returns the Steam compatdata directory used for Proton prefixes.
 *
 * @returns Path to compatdata (e.g. ~/.steam/steam/steamapps/compatdata)
 * @throws Error if home directory is not found
 */
export function getCompatDataDir(): string {
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new Error('Home directory not found');
  }
  return `${homeDir}/.steam/steam/steamapps/compatdata`;
}

/**
 * Returns the Proton/WINE prefix path for a given Steam app ID.
 *
 * @param steamAppId - Steam app ID (e.g. non-Steam shortcut ID)
 * @returns Path to the pfx directory for that app
 */
export function getProtonPrefixPath(steamAppId: number): string {
  const compatDataDir = getCompatDataDir();
  return `${compatDataDir}/${steamAppId}/pfx`;
}
