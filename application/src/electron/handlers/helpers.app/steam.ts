/** Native Steam shortcut helpers. */

import * as fs from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { PlatformError } from '@ogi/errors';
import { Effect } from 'effect';
import { getOgiExecutablePath } from '@/electron/handlers/helpers.app/platform.js';
import {
  findShortcut,
  generateNonSteamAppId,
  isSteamRunning,
  locateSteam,
  readShortcuts,
  removeShortcut,
  updateShortcutsFile,
  upsertShortcut,
  writeFileAtomic,
} from '@/electron/lib/steam-vdf.js';
import { __dirname } from '@/electron/manager/manager.paths.js';

export function getVersionedGameName(
  name: string,
  version?: string | null
): string {
  if (!version || !version.trim()) return name;
  return `${name} (${version})`;
}

const steamError = (message: string): PlatformError =>
  new PlatformError({ message, platform: process.platform });

/** Resolve an existing shortcut by its exact display name. */
export function getNonSteamGameAppID(
  gameName: string
): Effect.Effect<number, PlatformError> {
  return Effect.try({
    try: () => {
      const steam = locateSteam();
      if (!steam)
        throw new Error(
          'No Steam installation with a userdata account was found'
        );
      if (!fs.existsSync(steam.user.shortcutsPath)) {
        throw new Error(
          `Steam shortcuts file does not exist for account ${steam.user.accountId}`
        );
      }
      const { shortcuts } = readShortcuts(
        fs.readFileSync(steam.user.shortcutsPath)
      );
      const shortcut = findShortcut(shortcuts, [gameName]);
      if (!shortcut)
        throw new Error(`Could not find Steam shortcut "${gameName}"`);
      return shortcut.appId;
    },
    catch: (cause) =>
      steamError(cause instanceof Error ? cause.message : String(cause)),
  });
}

/** Prefer the current versioned shortcut while retaining legacy plain-name lookup. */
export function getSteamAppIdWithFallback(
  name: string,
  version?: string | null,
  context?: string
): Effect.Effect<number, PlatformError> {
  const versionedName = getVersionedGameName(name, version);
  return getNonSteamGameAppID(versionedName).pipe(
    Effect.catchAll(() =>
      versionedName === name
        ? Effect.fail(steamError(`Could not find Steam shortcut "${name}"`))
        : getNonSteamGameAppID(name).pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                console.log(
                  `${context ? `[${context}] ` : ''}Using legacy plain-name Steam shortcut "${name}"`
                )
              )
            )
          )
    )
  );
}

/**
 * Add or update an OGI-owned non-Steam shortcut without touching unrelated
 * entries. Steam must be closed because it rewrites shortcuts.vdf on exit.
 */
export function addGameToSteam(params: {
  name: string;
  version?: string;
  launchExecutable: string;
  cwd: string;
  wrapperCommand?: string;
  appID: number;
}): Effect.Effect<boolean> {
  return Effect.promise(async () => {
    try {
      const steam = locateSteam();
      if (!steam)
        throw new Error(
          'No Steam installation with a userdata account was found'
        );
      const appName = getVersionedGameName(params.name, params.version);
      const ogiExecutable = getOgiExecutablePath();
      updateShortcutsFile(steam.user.shortcutsPath, (root) => {
        upsertShortcut(root, {
          appName,
          previousNames: appName === params.name ? [] : [params.name],
          executable: ogiExecutable,
          startDir: dirname(ogiExecutable),
          launchOptions: `--game-id=${params.appID} --no-sandbox`,
          tags: ['OpenGameInstaller'],
        });
      });
      const shortcutId = generateNonSteamAppId(ogiExecutable, appName);
      console.log(
        `[steam] ${appName} is configured for account ${steam.user.accountId} as ${shortcutId}`
      );
      await downloadSteamGridArtwork(
        appName,
        shortcutId,
        steam.user.userdataPath
      );
      return true;
    } catch (error) {
      console.error('[steam] Failed to add shortcut:', error);
      return false;
    }
  });
}

type SteamGridDbResponse<T> = { success: boolean; data: T };
type SteamGridDbGame = { id: number };
type SteamGridDbImage = { url: string };

const readSteamGridDbKey = (): string | undefined => {
  const configPath = join(__dirname, 'config/option/steamgriddb.json');
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      apiKey?: unknown;
    };
    return typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
      ? parsed.apiKey.trim()
      : undefined;
  } catch (error) {
    console.warn(
      '[steam] Could not read native SteamGridDB configuration:',
      error
    );
    return undefined;
  }
};

const fetchSteamGridDb = async <T>(url: string, apiKey: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok)
    throw new Error(`SteamGridDB request failed with ${response.status}`);
  const body = (await response.json()) as SteamGridDbResponse<T>;
  if (!body.success) throw new Error('SteamGridDB request was unsuccessful');
  return body.data;
};

const downloadSteamGridArtwork = async (
  appName: string,
  appId: number,
  userdataPath: string
): Promise<void> => {
  const apiKey = readSteamGridDbKey();
  if (!apiKey) return;
  try {
    const games = await fetchSteamGridDb<SteamGridDbGame[]>(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(appName)}`,
      apiKey
    );
    const game = games[0];
    if (!game) return;
    const requests = [
      { endpoint: `grids/game/${game.id}?dimensions=600x900`, suffix: 'p' },
      { endpoint: `grids/game/${game.id}?dimensions=920x430`, suffix: '' },
      { endpoint: `heroes/game/${game.id}`, suffix: '_hero' },
      { endpoint: `logos/game/${game.id}`, suffix: '_logo' },
      { endpoint: `icons/game/${game.id}`, suffix: '_icon' },
    ];
    const gridDirectory = join(userdataPath, 'config/grid');
    await Promise.all(
      requests.map(async ({ endpoint, suffix }) => {
        const images = await fetchSteamGridDb<SteamGridDbImage[]>(
          `https://www.steamgriddb.com/api/v2/${endpoint}`,
          apiKey
        );
        const artwork = images[0];
        if (!artwork) return;
        const response = await fetch(artwork.url);
        if (!response.ok) return;
        if (isSteamRunning())
          throw new Error('Steam started while artwork was downloading');
        const extension = extname(new URL(artwork.url).pathname).toLowerCase();
        const safeExtension = ['.png', '.jpg', '.jpeg', '.webp'].includes(
          extension
        )
          ? extension
          : '.png';
        writeFileAtomic(
          join(gridDirectory, `${appId}${suffix}${safeExtension}`),
          Buffer.from(await response.arrayBuffer())
        );
      })
    );
  } catch (error) {
    console.warn(`[steam] Could not download artwork for ${appName}:`, error);
  }
};

export function removeGameFromSteam(
  name: string,
  version?: string | null
): Effect.Effect<boolean> {
  return Effect.sync(() => {
    try {
      const steam = locateSteam();
      if (!steam || !fs.existsSync(steam.user.shortcutsPath)) return false;
      const names = [getVersionedGameName(name, version), name];
      let removed = false;
      updateShortcutsFile(steam.user.shortcutsPath, (root) => {
        removed = removeShortcut(root, (shortcut) =>
          names.includes(shortcut.appName)
        );
      });
      return removed;
    } catch (error) {
      console.error('[steam] Failed to remove shortcut:', error);
      return false;
    }
  });
}
