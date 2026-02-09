/**
 * Platform-related utility functions
 */
export function isLinux() {
    return process.platform === 'linux';
}
export function getHomeDir() {
    return process.env.HOME || process.env.USERPROFILE || null;
}
export function getCompatDataDir() {
    const homeDir = getHomeDir();
    if (!homeDir) {
        throw new Error('Home directory not found');
    }
    return `${homeDir}/.steam/steam/steamapps/compatdata`;
}
export function getProtonPrefixPath(steamAppId) {
    const compatDataDir = getCompatDataDir();
    return `${compatDataDir}/${steamAppId}/pfx`;
}
//# sourceMappingURL=platform.js.map