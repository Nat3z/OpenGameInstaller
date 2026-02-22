/**
 * Platform-related utility functions
 */

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function getHomeDir(): string | null {
  return process.env.HOME || process.env.USERPROFILE || null;
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
