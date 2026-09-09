import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import type { FailedSetup, PersistedDownload } from '@/lib/download-state.js';
import type { Settings, UpdateState } from '@/lib/state.js';
import type { AppDatabase } from './database.js';

// One-shot import of the pre-4.4 JSON state directory. The source files are
// left untouched so a downgrade still finds its data.

const readJson = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJsonDirectory = (directory: string): Record<string, unknown>[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(join(directory, file)))
    .filter(isRecord);
};

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

const pick = <A>(
  source: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is A
): A | undefined => (guard(source[key]) ? (source[key] as A) : undefined);

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

const importSettings = (directory: string): Partial<Settings> => {
  const option = (name: string): Record<string, unknown> => {
    const value = readJson(join(directory, 'config/option', `${name}.json`));
    return isRecord(value) ? value : {};
  };
  const general = option('general');
  const debrid = option('realdebrid');
  const qbit = option('qbittorrent');
  const developer = option('developer');
  const steamGrid = option('steamgriddb');
  const theme = general.theme;
  const patch: Partial<Settings> = {
    ...(theme === 'light' || theme === 'dark' || theme === 'synthwave'
      ? { theme }
      : {}),
    fileDownloadLocation: pick(general, 'fileDownloadLocation', isString),
    torrentClient: pick(general, 'torrentClient', isString) as
      | Settings['torrentClient']
      | undefined,
    parallelChunkCount: pick(general, 'parallelChunkCount', isNumber),
    bandwidthLimit: pick(general, 'bandwidthLimit', isNumber),
    steamCompatibilityTool: pick(general, 'steamCompatibilityTool', isString),
    addons: stringList(general.addons),
    marketplaceSources: stringList(general.marketplaceSources),
    debridApiKey: pick(debrid, 'debridApiKey', isString),
    torboxApiKey: pick(debrid, 'torboxApiKey', isString),
    premiumizeApiKey: pick(debrid, 'premiumizeApiKey', isString),
    alldebridApiKey: pick(debrid, 'alldebridApiKey', isString),
    qbitHost: pick(qbit, 'qbitHost', isString),
    qbitPort: pick(qbit, 'qbitPort', isString),
    qbitUsername: pick(qbit, 'qbitUsername', isString),
    qbitPassword: pick(qbit, 'qbitPassword', isString),
    disableSecretCheck: pick(developer, 'disableSecretCheck', isBoolean),
    clientSdkUrl: pick(developer, 'clientSdkUrl', isString),
    steamGridDbApiKey: pick(steamGrid, 'apiKey', isString)?.trim(),
  };
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (patch[key] === undefined) delete patch[key];
  }
  if (patch.marketplaceSources?.length === 0) delete patch.marketplaceSources;
  return patch;
};

const isLibraryInfo = (value: unknown): value is LibraryInfo =>
  isRecord(value) &&
  isNumber(value.appID) &&
  isString(value.name) &&
  isString(value.cwd) &&
  isString(value.launchExecutable);

/** Pre-2.0 entries keyed by `steamAppID`; folded in from the old `convertLibrary` step. */
const upgradeSteamEntry = (value: unknown): unknown => {
  if (
    !isRecord(value) ||
    !isNumber(value.steamAppID) ||
    isNumber(value.appID)
  ) {
    return value;
  }
  const { steamAppID, ...rest } = value;
  return {
    ...rest,
    appID: steamAppID,
    coverImage: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${steamAppID}/library_hero.jpg`,
    titleImage: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${steamAppID}/logo_2x.png`,
    addonsource: 'steam',
    storefront: 'steam',
  };
};

const importLibrary = (directory: string, database: AppDatabase): void => {
  const libraryDirectory = join(directory, 'library');
  if (!existsSync(libraryDirectory)) return;
  // A `.ogi-removing-*` tombstone is a removal that never committed; treat it
  // as still owned unless the live file exists.
  const files = readdirSync(libraryDirectory);
  for (const file of files) {
    const removing = file.match(/^(\d+)\.json\.ogi-removing-\d+-\d+$/);
    const isLive = /^\d+\.json$/.test(file);
    if (!isLive && !(removing && !files.includes(`${removing[1]}.json`))) {
      continue;
    }
    const info = upgradeSteamEntry(readJson(join(libraryDirectory, file)));
    if (!isLibraryInfo(info)) continue;
    database.saveGame({
      ...info,
      version: isString(info.version) ? info.version : '',
      capsuleImage: isString(info.capsuleImage) ? info.capsuleImage : '',
      coverImage: isString(info.coverImage) ? info.coverImage : '',
      storefront: isString(info.storefront) ? info.storefront : '',
      addonsource: isString(info.addonsource) ? info.addonsource : '',
    });
  }
  const recent = readJson(join(directory, 'internals/apps.json'));
  if (Array.isArray(recent)) {
    database.setRecentOrder(recent.filter(isNumber));
  }
};

const importUpdateState = (directory: string): UpdateState | undefined => {
  const value = readJson(join(directory, 'internals/update-state.json'));
  if (!isRecord(value)) return undefined;
  const requiredReadds = Array.isArray(value.requiredReadds)
    ? value.requiredReadds.filter(
        (entry): entry is UpdateState['requiredReadds'][number] =>
          isRecord(entry) &&
          isNumber(entry.appID) &&
          (entry.steamAppId === undefined || isNumber(entry.steamAppId))
      )
    : [];
  const dismissedUpdates = Array.isArray(value.dismissedUpdates)
    ? value.dismissedUpdates.filter(
        (entry): entry is UpdateState['dismissedUpdates'][number] =>
          isRecord(entry) &&
          isNumber(entry.appID) &&
          isString(entry.updateVersion)
      )
    : [];
  return { requiredReadds, dismissedUpdates };
};

const isPersistedDownload = (value: unknown): value is PersistedDownload =>
  isRecord(value) &&
  isString(value.id) &&
  isRecord(value.downloadInfo) &&
  isString(value.downloadInfo.id) &&
  isNumber(value.downloadInfo.appID);

const isFailedSetup = (value: unknown): value is FailedSetup =>
  isRecord(value) &&
  isString(value.id) &&
  isRecord(value.downloadInfo) &&
  isRecord(value.setupData) &&
  (value.should === 'call-addon' ||
    value.should === 'call-unrar' ||
    value.should === 'call-unzip');

/** Imports every legacy JSON file found under `directory` exactly once. */
export function importLegacyState(
  directory: string,
  database: AppDatabase
): boolean {
  if (database.legacyImportedAt() !== null) return false;
  database.transaction(() => {
    database.updateSettings(importSettings(directory));

    const installed = readJson(join(directory, 'config/option/installed.json'));
    const lastVersionPath = join(directory, 'config/option/lastVersion.txt');
    database.updateAppState({
      installed: isRecord(installed) && installed.installed === true,
      oobeRestartRequired:
        isRecord(installed) && installed.restartRequired === true,
      lastVersion: existsSync(lastVersionPath)
        ? readFileSync(lastVersionPath, 'utf-8').trim() || null
        : null,
    });

    const configDirectory = join(directory, 'config');
    if (existsSync(configDirectory)) {
      for (const file of readdirSync(configDirectory)) {
        const addonId = file.match(/^([A-Za-z0-9_-]+)\.json$/)?.[1];
        const values = addonId && readJson(join(configDirectory, file));
        if (!addonId || !isRecord(values)) continue;
        database.setAddonConfig(
          addonId,
          Object.fromEntries(
            Object.entries(values).filter(
              (entry): entry is [string, string | number | boolean] =>
                isString(entry[1]) || isNumber(entry[1]) || isBoolean(entry[1])
            )
          )
        );
      }
    }

    importLibrary(directory, database);

    const updateState = importUpdateState(directory);
    if (updateState) database.setUpdateState(updateState);

    for (const record of readJsonDirectory(
      join(directory, 'in-progress-downloads')
    )) {
      if (isPersistedDownload(record)) {
        database.saveDownload({
          ...record,
          updatedAt: isNumber(record.updatedAt) ? record.updatedAt : Date.now(),
        });
      }
    }
    for (const record of readJsonDirectory(join(directory, 'failed-setups'))) {
      if (isFailedSetup(record)) {
        database.saveFailedSetup({
          ...record,
          timestamp: isNumber(record.timestamp) ? record.timestamp : Date.now(),
          retryCount: isNumber(record.retryCount) ? record.retryCount : 0,
          error: isString(record.error) ? record.error : '',
        });
      }
    }

    database.markLegacyImported();
  });
  return true;
}
