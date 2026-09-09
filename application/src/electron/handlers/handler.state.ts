import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { extname } from 'node:path';
import { ConfigError, formatError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import axios from 'axios';
import { Effect } from 'effect';
import { getDatabase } from '@/electron/database/index.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary as runBoundary } from '@/electron/runtime.js';
import type { FailedSetup, PersistedDownload } from '@/lib/download-state.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';
import {
  type AddonConfigValues,
  type AppState,
  DEFAULT_SETTINGS,
  type Settings,
  type UpdateState,
} from '@/lib/state.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

const invalid = (message: string, field: string) =>
  Effect.fail(new ValidationError({ message, field }));

const THEMES: readonly string[] = ['light', 'dark', 'synthwave'];
const TORRENT_CLIENTS: readonly string[] = [
  'webtorrent',
  'qbittorrent',
  'real-debrid',
  'all-debrid',
  'torbox',
  'premiumize',
  'disable',
];
const FAILED_SETUP_ACTIONS: readonly string[] = [
  'call-addon',
  'call-unrar',
  'call-unzip',
];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Renderer settings arrive as an untyped patch, so every key is checked against
 * the default it replaces before it can reach the database.
 */
const validateSettingsPatch = (
  patch: unknown
): Effect.Effect<Partial<Settings>, ValidationError> =>
  Effect.gen(function* () {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return yield* invalid('Settings patch must be an object', 'settings');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
        return yield* invalid(`Unknown setting "${key}"`, key);
      }
      const expected = DEFAULT_SETTINGS[key as keyof Settings];
      if (Array.isArray(expected)) {
        if (!isStringArray(value)) {
          return yield* invalid(`${key} must be an array of strings`, key);
        }
      } else if (typeof expected === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return yield* invalid(`${key} must be a finite number`, key);
        }
      } else if (typeof expected === 'boolean') {
        if (typeof value !== 'boolean') {
          return yield* invalid(`${key} must be a boolean`, key);
        }
      } else if (typeof value !== 'string') {
        return yield* invalid(`${key} must be a string`, key);
      }
    }
    const typed = patch as Partial<Settings>;
    if (typed.theme !== undefined && !THEMES.includes(typed.theme)) {
      return yield* invalid(`Unknown theme "${typed.theme}"`, 'theme');
    }
    if (
      typed.torrentClient !== undefined &&
      !TORRENT_CLIENTS.includes(typed.torrentClient)
    ) {
      return yield* invalid(
        `Unknown torrent client "${typed.torrentClient}"`,
        'torrentClient'
      );
    }
    return typed;
  });

const validateAppStatePatch = (
  patch: unknown
): Effect.Effect<Partial<AppState>, ValidationError> =>
  Effect.gen(function* () {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return yield* invalid('App state patch must be an object', 'appState');
    }
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      if (key === 'installed' || key === 'oobeRestartRequired') {
        if (typeof value !== 'boolean') {
          return yield* invalid(`${key} must be a boolean`, key);
        }
      } else if (key === 'lastVersion') {
        if (value !== null && typeof value !== 'string') {
          return yield* invalid('lastVersion must be a string or null', key);
        }
      } else {
        return yield* invalid(`Unknown app state key "${key}"`, key);
      }
    }
    return patch as Partial<AppState>;
  });

const ADDON_ID = /^[A-Za-z0-9_-]+$/;

const validateAddonId = (
  addonId: unknown
): Effect.Effect<string, ValidationError> =>
  typeof addonId === 'string' && ADDON_ID.test(addonId)
    ? Effect.succeed(addonId)
    : invalid(`Invalid addon id "${String(addonId)}"`, 'addonId');

const validateAddonConfig = (
  values: unknown
): Effect.Effect<AddonConfigValues, ValidationError> =>
  Effect.gen(function* () {
    if (
      typeof values !== 'object' ||
      values === null ||
      Array.isArray(values)
    ) {
      return yield* invalid('Addon config must be an object', 'values');
    }
    for (const [key, value] of Object.entries(values)) {
      const type = typeof value;
      if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        return yield* invalid(
          `Addon config "${key}" must be a string, number, or boolean`,
          key
        );
      }
    }
    return values as AddonConfigValues;
  });

// Download and failed-setup blobs are renderer-owned shapes; only the fields
// the database keys on are checked.
const validateDownload = (
  record: unknown
): Effect.Effect<PersistedDownload, ValidationError> =>
  Effect.gen(function* () {
    if (typeof record !== 'object' || record === null) {
      return yield* invalid('Download record must be an object', 'record');
    }
    const candidate = record as PersistedDownload;
    if (typeof candidate.id !== 'string' || candidate.id === '') {
      return yield* invalid('Download record needs an id', 'id');
    }
    if (
      typeof candidate.downloadInfo !== 'object' ||
      candidate.downloadInfo === null
    ) {
      return yield* invalid(
        'Download record needs downloadInfo',
        'downloadInfo'
      );
    }
    if (candidate.downloadInfo.id !== candidate.id) {
      return yield* invalid(
        'Download record id must match downloadInfo.id',
        'id'
      );
    }
    if (!Number.isInteger(candidate.downloadInfo.appID)) {
      return yield* invalid(
        'downloadInfo.appID must be an integer',
        'downloadInfo.appID'
      );
    }
    return candidate;
  });

const validateFailedSetup = (
  setup: unknown
): Effect.Effect<FailedSetup, ValidationError> =>
  Effect.gen(function* () {
    if (typeof setup !== 'object' || setup === null) {
      return yield* invalid('Failed setup must be an object', 'setup');
    }
    const candidate = setup as FailedSetup;
    if (typeof candidate.id !== 'string' || candidate.id === '') {
      return yield* invalid('Failed setup needs an id', 'id');
    }
    if (!FAILED_SETUP_ACTIONS.includes(candidate.should)) {
      return yield* invalid(
        `Unknown failed setup action "${String(candidate.should)}"`,
        'should'
      );
    }
    return candidate;
  });

const validateUpdateState = (
  state: unknown
): Effect.Effect<UpdateState, ValidationError> =>
  Effect.gen(function* () {
    if (typeof state !== 'object' || state === null) {
      return yield* invalid('Update state must be an object', 'updateState');
    }
    const candidate = state as UpdateState;
    if (
      !Array.isArray(candidate.requiredReadds) ||
      candidate.requiredReadds.some((entry) => !Number.isInteger(entry?.appID))
    ) {
      return yield* invalid(
        'requiredReadds must be entries with an integer appID',
        'requiredReadds'
      );
    }
    if (
      !Array.isArray(candidate.dismissedUpdates) ||
      candidate.dismissedUpdates.some(
        (entry) =>
          !Number.isInteger(entry?.appID) ||
          typeof entry?.updateVersion !== 'string'
      )
    ) {
      return yield* invalid(
        'dismissedUpdates must be entries with an integer appID and a version',
        'dismissedUpdates'
      );
    }
    return candidate;
  });

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(host)) {
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host.startsWith('::ffff:')
    );
  }
  return false;
};

const EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const mimeTypeFor = (contentType: string | undefined, url: string): string => {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared?.startsWith('image/')) return declared;
  return (
    EXTENSION_MIME[extname(new URL(url).pathname).toLowerCase()] ?? 'image/jpeg'
  );
};

const toDataUrl = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

/**
 * Returns the image at `url` as a data URL, served from the cache when it has
 * been fetched before. The cache key is derived from the URL so a renderer
 * cannot poison one entry with another resource.
 */
const loadImage = (url: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(url),
      catch: () =>
        new ValidationError({ message: 'Invalid image URL', field: 'url' }),
    });
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return yield* invalid('Image URL must be http(s)', 'url');
    }
    if (isPrivateHost(parsed.hostname)) {
      return yield* invalid('Image URL must not target a local host', 'url');
    }
    const key = createHash('sha256').update(parsed.href).digest('hex');
    const cached = yield* Effect.sync(() => getDatabase().getCachedImage(key));
    if (cached) return toDataUrl(cached.mimeType, cached.bytes);

    const response = yield* Effect.tryPromise({
      try: () =>
        axios.get<ArrayBuffer>(parsed.href, { responseType: 'arraybuffer' }),
      catch: (cause) =>
        new ConfigError({
          message: `Failed to fetch image: ${formatError(cause)}`,
          key,
        }),
    });
    const bytes = new Uint8Array(Buffer.from(response.data));
    const mimeType = mimeTypeFor(
      response.headers['content-type'] as string | undefined,
      parsed.href
    );

    // A cache write failure costs a re-fetch next time, nothing more.
    yield* Effect.try({
      try: () => getDatabase().putCachedImage(key, mimeType, bytes),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.sync(() =>
          logger.sync.warn('[state] Could not cache image', cause)
        )
      )
    );
    return toDataUrl(mimeType, bytes);
  });

export default function stateHandler() {
  return router(
    procedure(ElectronRpc.state.getSettings, () =>
      runBoundary(Effect.sync(() => getDatabase().getSettings()))
    ),
    procedure(ElectronRpc.state.updateSettings, (patch: unknown) =>
      runBoundary(
        validateSettingsPatch(patch).pipe(
          Effect.map((validated) => getDatabase().updateSettings(validated))
        )
      )
    ),
    procedure(ElectronRpc.state.getAppState, () =>
      runBoundary(Effect.sync(() => getDatabase().getAppState()))
    ),
    procedure(ElectronRpc.state.updateAppState, (patch: unknown) =>
      runBoundary(
        validateAppStatePatch(patch).pipe(
          Effect.map((validated) => getDatabase().updateAppState(validated))
        )
      )
    ),
    procedure(ElectronRpc.state.getAddonConfig, (addonId: unknown) =>
      runBoundary(
        validateAddonId(addonId).pipe(
          Effect.map((id) => getDatabase().getAddonConfig(id))
        )
      )
    ),
    procedure(
      ElectronRpc.state.setAddonConfig,
      (addonId: unknown, values: unknown) =>
        runBoundary(
          Effect.gen(function* () {
            const id = yield* validateAddonId(addonId);
            const config = yield* validateAddonConfig(values);
            getDatabase().setAddonConfig(id, config);
          })
        )
    ),
    procedure(ElectronRpc.state.getUpdateState, () =>
      runBoundary(Effect.sync(() => getDatabase().getUpdateState()))
    ),
    procedure(ElectronRpc.state.setUpdateState, (state: unknown) =>
      runBoundary(
        validateUpdateState(state).pipe(
          Effect.map((validated) => getDatabase().setUpdateState(validated))
        )
      )
    ),
    procedure(ElectronRpc.state.listDownloads, () =>
      runBoundary(Effect.sync(() => getDatabase().listDownloads()))
    ),
    procedure(ElectronRpc.state.saveDownload, (record: unknown) =>
      runBoundary(
        validateDownload(record).pipe(
          Effect.map((validated) => getDatabase().saveDownload(validated))
        )
      )
    ),
    procedure(ElectronRpc.state.deleteDownload, (id: string) =>
      runBoundary(Effect.sync(() => getDatabase().deleteDownload(id)))
    ),
    procedure(ElectronRpc.state.listFailedSetups, () =>
      runBoundary(Effect.sync(() => getDatabase().listFailedSetups()))
    ),
    procedure(ElectronRpc.state.saveFailedSetup, (setup: unknown) =>
      runBoundary(
        validateFailedSetup(setup).pipe(
          Effect.map((validated) => getDatabase().saveFailedSetup(validated))
        )
      )
    ),
    procedure(ElectronRpc.state.deleteFailedSetup, (id: string) =>
      runBoundary(Effect.sync(() => getDatabase().deleteFailedSetup(id)))
    ),
    procedure(ElectronRpc.state.loadImage, (url: string) =>
      runBoundary(loadImage(url))
    )
  );
}
