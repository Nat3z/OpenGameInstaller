import type { SearchResult, SetupEventResponse } from '@ogi-sdk/connect';
import {
  AddonCalls,
  type DownloadRecord,
  DownloadStore,
  Installer,
  PipelineConfig,
  SleepLock,
} from '@ogi-sdk/core';
import { AddonError, formatError, LibraryError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import {
  insertApp,
  updateAppVersion,
} from '@/electron/handlers/handler.library.js';
import { installRedistributables } from '@/electron/handlers/handler.redists.js';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';
import { type AppEffect, runElectronEffect } from '@/electron/runtime.js';
import { getAddonServer } from '@/electron/server/addon-server.js';
import { Database, Settings } from '@/electron/services/index.js';
import type { DownloadStatusAndInfo } from '@/lib/download-state.js';

/** Runs an app effect from an adapter, keeping failures typed. */
const onApp = <A, E, E2>(
  effect: AppEffect<A, E>,
  toError: (cause: unknown) => E2
): Effect.Effect<A, E2> =>
  Effect.promise(() => runElectronEffect(Effect.either(effect))).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Right'
        ? Effect.succeed(result.right)
        : Effect.fail(toError(result.left))
    )
  );

// ---- addon calls ------------------------------------------------------------

const addon = (addonId: string) =>
  Effect.suspend(() => {
    const connection = getAddonServer().getClient(addonId);
    return connection
      ? Effect.succeed(connection)
      : Effect.fail(
          new AddonError({ message: `Addon ${addonId} is not running` })
        );
  });

/**
 * Core's addon-calls adapter: deferred `request-dl` and `setup` straight on
 * the in-process addon server. Input the addon asks for goes to core
 * `Prompts` through the server's `askInput`.
 */
export const AddonCallsFromAddonServer = Layer.succeed(AddonCalls, {
  requestDownload: (addonId, appID, result) =>
    addon(addonId).pipe(
      Effect.flatMap((connection) =>
        connection.deferred('request-dl', [
          appID,
          JSON.parse(JSON.stringify(result)) as SearchResult,
        ])
      ),
      Effect.mapError(
        (cause) =>
          new AddonError({
            message: `The addon could not find the download: ${formatError(cause)}`,
            addonName: addonId,
          })
      ),
      Effect.flatMap((reply) =>
        reply
          ? Effect.succeed(reply as SearchResult)
          : Effect.fail(
              new AddonError({
                message: 'The addon returned no download',
                addonName: addonId,
              })
            )
      )
    ),
  setup: (addonId, data, onProgress) =>
    addon(addonId).pipe(
      Effect.flatMap((connection) =>
        connection.deferred('setup', [data], onProgress)
      ),
      Effect.map((reply) => reply as SetupEventResponse),
      Effect.mapError(
        (cause) =>
          new AddonError({
            message:
              formatError(cause) || 'The addon crashed while setting up.',
            addonName: addonId,
          })
      )
    ),
});

// ---- installer ---------------------------------------------------------------

const libraryError = (cause: unknown) =>
  cause instanceof LibraryError
    ? cause
    : new LibraryError({ message: formatError(cause) });

export const InstallerFromLibrary = Layer.succeed(Installer, {
  install: (info) =>
    onApp(insertApp(info), libraryError).pipe(
      Effect.map((result) =>
        result === 'setup-prefix-required'
          ? ('needs-redistributables' as const)
          : result === 'setup-failed'
            ? ('failed' as const)
            : ('installed' as const)
      )
    ),
  update: (appID, setup, addonSource) =>
    onApp(
      updateAppVersion({
        appID,
        version: setup.version,
        cwd: setup.cwd,
        launchExecutable: setup.launchExecutable,
        launchArguments: setup.launchArguments,
        addonSource,
        umu: setup.umu,
        launchEnv: setup.launchEnv,
      }),
      libraryError
    ).pipe(
      Effect.flatMap((result) =>
        result === 'app-not-found'
          ? Effect.fail(
              new LibraryError({
                message: 'App not found in library',
                gameId: appID,
              })
            )
          : Effect.void
      )
    ),
  redistributables: (appID, downloadId) =>
    onApp(installRedistributables(appID, downloadId), libraryError).pipe(
      Effect.map((result) =>
        result === 'success'
          ? 'success'
          : result === 'partial'
            ? 'partial'
            : 'failed'
      )
    ),
});

// ---- persistence -----------------------------------------------------------------

/**
 * Core's records live in the existing `downloads` table, under the
 * `pipeline` key of `download_info`. The setup path guards already trust
 * that table's `downloadPath`, so recorded downloads stay writable.
 */
type StoredInfo = DownloadStatusAndInfo & { pipeline?: DownloadRecord };

const toRow = (record: DownloadRecord): StoredInfo =>
  ({
    ...record.request,
    id: record.id,
    appID: record.appID,
    status: record.error ? 'error' : 'paused',
    progress: 0,
    downloadPath: record.path,
    files: record.files.map((file) => ({
      name: file.path.split(/[/\\]/).pop() ?? '',
      path: file.path,
      downloadURL: file.link,
      headers: file.headers,
    })),
    downloadSpeed: 0,
    downloadSize: 0,
    capsuleImage: record.request.capsuleImage ?? '',
    coverImage: record.request.coverImage ?? '',
    pipeline: record,
  }) as StoredInfo;

export const DownloadStoreFromDatabase = Layer.succeed(DownloadStore, {
  list: onApp(
    Effect.flatMap(Database, (database) => database.downloads.list),
    () => undefined
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) => {
        const record = (row.downloadInfo as StoredInfo).pipeline;
        return record ? [record] : [];
      })
    ),
    Effect.orElseSucceed(() => [])
  ),
  save: (record) =>
    onApp(
      Effect.flatMap(Database, (database) =>
        database.downloads.save({
          id: record.id,
          updatedAt: record.updatedAt,
          downloadInfo: toRow(record),
        })
      ),
      () => undefined
    ).pipe(Effect.ignore),
  remove: (id) =>
    onApp(
      Effect.flatMap(Database, (database) => database.downloads.delete(id)),
      () => undefined
    ).pipe(Effect.ignore),
});

// ---- settings and power -------------------------------------------------------------

export const PipelineConfigFromSettings = Layer.succeed(PipelineConfig, {
  get: onApp(
    Effect.flatMap(Settings, (settings) => settings.get),
    () => undefined
  ).pipe(
    Effect.map((settings) => ({
      downloadRoot: settings.fileDownloadLocation || './downloads',
      torrents:
        settings.torrentClient === 'disable'
          ? ('disable' as const)
          : settings.torrentClient === 'real-debrid'
            ? ('realdebrid' as const)
            : settings.torrentClient === 'all-debrid'
              ? ('alldebrid' as const)
              : settings.torrentClient === 'torbox' ||
                  settings.torrentClient === 'premiumize'
                ? settings.torrentClient
                : ('local' as const),
    })),
    Effect.orElseSucceed(() => ({
      downloadRoot: './downloads',
      torrents: 'local' as const,
    }))
  ),
});

export const SleepLockFromPowerSave = Layer.succeed(SleepLock, {
  set: (active) =>
    Effect.sync(() => setPowerSaveBlockActive(active)).pipe(Effect.ignore),
});
