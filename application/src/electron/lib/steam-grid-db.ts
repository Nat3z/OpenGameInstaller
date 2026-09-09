import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type DatabaseError, SteamArtworkError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { runElectronEffect } from '@/electron/runtime.js';
import { Settings } from '@/electron/services/index.js';
import { writeFileAtomic } from './steam-installation.js';

const ARTWORK_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

type SteamGridDbResponse<T> = { success: boolean; data: T };
type SteamGridDbGame = { id: number };
type SteamGridDbImage = { url: string };

export type SteamGridDbMigrationStatus =
  | 'already-configured'
  | 'migrated'
  | 'not-found';

export const readSteamGridDbKey = (): Effect.Effect<
  string | undefined,
  DatabaseError,
  Settings
> =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const { steamGridDbApiKey } = yield* settings.get;
    const apiKey = steamGridDbApiKey.trim();
    return apiKey === '' ? undefined : apiKey;
  });

export const writeSteamGridDbKey = (
  apiKey: string
): Effect.Effect<void, DatabaseError | SteamArtworkError, Settings> =>
  Effect.gen(function* () {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return yield* Effect.fail(
        new SteamArtworkError({
          message: 'SteamGridDB API key cannot be empty',
        })
      );
    }
    const settings = yield* Settings;
    yield* settings.update({ steamGridDbApiKey: trimmed });
  });

export const parseLegacySteamGridDbKey = (
  contents: string
): string | undefined => {
  let apiKey: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?SGDBAPIKEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))\s*(?:#.*)?$/
    );
    const value = match?.slice(1).find((candidate) => candidate !== undefined);
    if (value?.trim()) apiKey = value.trim();
  }
  return apiKey;
};

export const migrateLegacySteamGridDbKey = (options?: {
  homeDirectory?: string;
  xdgConfigHome?: string;
}): Effect.Effect<
  SteamGridDbMigrationStatus,
  DatabaseError | SteamArtworkError,
  Settings
> =>
  Effect.gen(function* () {
    if (yield* readSteamGridDbKey()) return 'already-configured';

    const homeDirectory = options?.homeDirectory ?? os.homedir();
    const xdgConfigHome = options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
    const candidates = [
      xdgConfigHome
        ? path.join(xdgConfigHome, 'steamtinkerlaunch/global.conf')
        : undefined,
      path.join(homeDirectory, '.config/steamtinkerlaunch/global.conf'),
      path.join(
        homeDirectory,
        '.var/app/com.valvesoftware.Steam/.config/steamtinkerlaunch/global.conf'
      ),
    ].filter((candidate): candidate is string => candidate !== undefined);
    const seen = new Set<string>();

    for (const candidate of candidates) {
      let canonicalPath: string;
      try {
        canonicalPath = fs.existsSync(candidate)
          ? fs.realpathSync.native(candidate)
          : path.resolve(candidate);
      } catch {
        continue;
      }
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      if (!fs.existsSync(canonicalPath)) continue;

      let apiKey: string | undefined;
      try {
        apiKey = parseLegacySteamGridDbKey(
          fs.readFileSync(canonicalPath, 'utf8')
        );
      } catch {
        continue;
      }
      if (!apiKey) continue;
      yield* writeSteamGridDbKey(apiKey);
      return 'migrated';
    }

    return 'not-found';
  });

const fetchSteamGridDb = async <T>(url: string, apiKey: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SteamGridDB request failed with ${response.status}`);
  }
  const body = (await response.json()) as SteamGridDbResponse<T>;
  if (!body.success) throw new Error('SteamGridDB request was unsuccessful');
  return body.data;
};

export const copySteamGridArtwork = (options: {
  oldAppId?: number;
  newAppId: number;
  userdataPath: string;
}): Effect.Effect<void, SteamArtworkError> =>
  Effect.try({
    try: () => {
      if (
        options.oldAppId === undefined ||
        options.oldAppId === options.newAppId
      ) {
        return;
      }
      const gridDirectory = path.join(options.userdataPath, 'config/grid');
      if (!fs.existsSync(gridDirectory)) return;
      const pattern = new RegExp(
        `^${options.oldAppId}(p|_hero|_logo|_icon)?(\\.(?:png|jpe?g|webp))$`,
        'i'
      );
      for (const file of fs.readdirSync(gridDirectory)) {
        const match = file.match(pattern);
        if (!match) continue;
        const destination = path.join(
          gridDirectory,
          `${options.newAppId}${match[1] ?? ''}${match[2].toLowerCase()}`
        );
        if (!fs.existsSync(destination)) {
          fs.copyFileSync(path.join(gridDirectory, file), destination);
        }
      }
    },
    catch: (cause) =>
      new SteamArtworkError({
        message: `Could not migrate Steam artwork to shortcut ${options.newAppId}`,
        cause,
      }),
  });

export const downloadSteamGridArtwork = (options: {
  appName: string;
  appId: number;
  userdataPath: string;
}): Effect.Effect<void, SteamArtworkError | DatabaseError, Settings> =>
  Effect.gen(function* () {
    let apiKey = yield* readSteamGridDbKey();
    if (!apiKey && process.platform === 'linux') {
      // A Steam Deck user may still have the key only in SteamTinkerLaunch.
      yield* migrateLegacySteamGridDbKey();
      apiKey = yield* readSteamGridDbKey();
    }
    if (!apiKey) return;
    yield* fetchArtwork(options, apiKey);
  });

const fetchArtwork = (
  options: { appName: string; appId: number; userdataPath: string },
  apiKey: string
): Effect.Effect<void, SteamArtworkError> =>
  Effect.tryPromise({
    try: async () => {
      const games = await fetchSteamGridDb<SteamGridDbGame[]>(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(options.appName)}`,
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
      const gridDirectory = path.join(options.userdataPath, 'config/grid');
      await Promise.all(
        requests.map(async ({ endpoint, suffix }) => {
          const hasArtwork = [...ARTWORK_EXTENSIONS].some((extension) =>
            fs.existsSync(
              path.join(gridDirectory, `${options.appId}${suffix}${extension}`)
            )
          );
          if (hasArtwork) return;
          const images = await fetchSteamGridDb<SteamGridDbImage[]>(
            `https://www.steamgriddb.com/api/v2/${endpoint}`,
            apiKey
          );
          const artwork = images[0];
          if (!artwork) return;
          const response = await fetch(artwork.url, {
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) return;
          const contentLength = Number(response.headers.get('content-length'));
          if (
            Number.isFinite(contentLength) &&
            contentLength > 20 * 1024 * 1024
          ) {
            throw new Error('SteamGridDB artwork exceeds the 20 MiB limit');
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 20 * 1024 * 1024) {
            throw new Error('SteamGridDB artwork exceeds the 20 MiB limit');
          }
          const extension = path
            .extname(new URL(artwork.url).pathname)
            .toLowerCase();
          const safeExtension = ARTWORK_EXTENSIONS.has(extension)
            ? extension
            : '.png';
          await runElectronEffect(
            writeFileAtomic(
              path.join(
                gridDirectory,
                `${options.appId}${suffix}${safeExtension}`
              ),
              bytes
            )
          );
        })
      );
    },
    catch: (cause) =>
      new SteamArtworkError({
        message: `Could not download artwork for ${options.appName}`,
        cause,
      }),
  });
