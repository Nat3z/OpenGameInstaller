import type { SearchResult, SetupEventResponse } from '@ogi-sdk/connect';
import {
  AddonCalls,
  type DownloadRecord,
  type DownloadRequest,
  DownloadStore,
  Installer,
  PipelineConfig,
  SleepLock,
} from '@ogi-sdk/core';
import {
  AddonError,
  DownloadError,
  formatError,
  LibraryError,
} from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import {
  insertApp,
  updateAppVersion,
} from '@/electron/handlers/handler.library.js';
import { installRedistributables } from '@/electron/handlers/handler.redists.js';
import { setPowerSaveBlockActive } from '@/electron/lib/power-save.js';
import { waitForAddonManifests } from '@/electron/manager/manager.addon-readiness.js';
import { type AppEffect, runElectronEffect } from '@/electron/runtime.js';
import { getAddonServer } from '@/electron/server/addon-server.js';
import { configureConnection } from '@/electron/server/addons-adapter.js';
import { Database, Settings } from '@/electron/services/index.js';
import type {
  DownloadStatusAndInfo,
  FailedSetup,
} from '@/lib/download-state.js';

/** Runs an app effect from an adapter, keeping failures typed. */
const onApp = <A, E, E2>(
  effect: AppEffect<A, E>,
  toError: (cause: unknown) => E2
): Effect.Effect<A, E2> =>
  // The signal ties host work to the caller: cancelling a download stops its
  // extraction or install instead of letting it run on unseen.
  Effect.promise((signal) =>
    runElectronEffect(Effect.either(effect), signal)
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Right'
        ? Effect.succeed(result.right)
        : Effect.fail(toError(result.left))
    )
  );

// ---- addon calls ------------------------------------------------------------

const lookup = (addonId: string) =>
  Effect.suspend(() => {
    const connection = getAddonServer().getClient(addonId);
    return connection
      ? Effect.succeed(connection)
      : Effect.fail(
          new AddonError({ message: `Addon ${addonId} is not running` })
        );
  });

// A setup restored at startup runs before addons have connected (and before
// the window sends their settings): wait for them once, then make sure this
// one is configured, so its handler can read its options.
const addon = (addonId: string) =>
  lookup(addonId).pipe(
    Effect.orElse(() =>
      waitForAddonManifests().pipe(Effect.zipRight(lookup(addonId)))
    ),
    Effect.tap((connection) =>
      Effect.promise(() => runElectronEffect(configureConnection(connection)))
    )
  );

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

/** The request part of a renderer-era row (everything but live state). */
const legacyRequest = (info: DownloadStatusAndInfo): DownloadRequest => {
  const {
    id: _id,
    appID: _appID,
    status: _status,
    progress: _progress,
    processingPhase: _phase,
    error: _error,
    usedDebridService: _debrid,
    downloadPath: _path,
    files,
    downloadSpeed: _speed,
    downloadSize: _size,
    ratio: _ratio,
    part: _part,
    totalParts: _totalParts,
    queuePosition: _queuePosition,
    originalDownloadURL,
    originalFiles,
    pausedAt: _pausedAt,
    isUpdate: _isUpdate,
    updateVersion: _updateVersion,
    isAddonDownload: _isAddonDownload,
    ...request
  } = info;
  // A direct download's `files` were its request too (setup reads their
  // names); a debrid one's `originalFiles` were, when it had them.
  const requestFiles =
    originalFiles ?? (info.downloadType === 'direct' ? files : undefined);
  return {
    ...request,
    ...(originalDownloadURL ? { downloadURL: originalDownloadURL } : {}),
    ...(requestFiles ? { files: requestFiles } : {}),
  } as DownloadRequest;
};

/** A renderer-era record, picked up where it was left. */
const fromLegacy = (
  info: DownloadStatusAndInfo,
  step: DownloadRecord['step'],
  extra: Partial<DownloadRecord> = {}
): DownloadRecord => ({
  id: info.id,
  appID: info.appID,
  request: legacyRequest(info),
  update:
    info.isUpdate && info.updateVersion
      ? { version: info.updateVersion }
      : undefined,
  path: info.downloadPath,
  files: info.files.map((file) => ({
    link: file.downloadURL,
    path: file.path ?? info.downloadPath,
    headers: file.headers,
  })),
  debrid:
    info.usedDebridService && info.usedDebridService !== 'none'
      ? info.usedDebridService
      : undefined,
  step,
  part: info.part,
  retryCount: 0,
  updatedAt: Date.now(),
  ...extra,
});

const legacyStep: Record<FailedSetup['should'], DownloadRecord['step']> = {
  'call-addon': 'setup',
  'call-unrar': 'extract-rar',
  'call-unzip': 'extract-zip',
};

export const DownloadStoreFromDatabase = Layer.succeed(DownloadStore, {
  // Rows from before the pipeline still show up: a download as paused (it
  // resumes by downloading again), a failed setup as a failed setup.
  list: onApp(
    Effect.flatMap(Database, (database) =>
      Effect.all([database.downloads.list, database.failedSetups.list])
    ),
    () => undefined
  ).pipe(
    Effect.map(([rows, failed]) => {
      const records = rows.flatMap((row) => {
        const info = row.downloadInfo as StoredInfo;
        if (info.pipeline) return [info.pipeline];
        // Raw addon downloads never had a setup; nothing to resume into.
        if (info.isAddonDownload || info.status === 'setup-complete') return [];
        // The game is installed; only its redistributables were running. Pick
        // up there (keeping a failure for retry), not with a fresh download.
        const redist = row.redistributableInstall;
        if (redist || info.status === 'installing-redistributables')
          return [
            fromLegacy(info, 'redistributables', {
              error: redist?.error,
            }),
          ];
        return [fromLegacy(info, 'download')];
      });
      // A retried legacy setup was saved as a pipeline row; that one wins.
      const known = new Set(records.map((record) => record.id));
      return [
        ...records,
        ...failed
          .filter((setup) => !known.has(setup.id))
          .map((setup) =>
            fromLegacy(setup.downloadInfo, legacyStep[setup.should], {
              path: setup.setupData.path,
              error: setup.error,
              retryCount: setup.retryCount,
              updatedAt: setup.timestamp,
            })
          ),
      ];
    }),
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
      (cause) =>
        new DownloadError({
          message: `Could not save the download: ${formatError(cause)}`,
          downloadId: record.id,
          cause,
        })
    ),
  remove: (id) =>
    onApp(
      Effect.flatMap(Database, (database) =>
        Effect.all([
          database.downloads.delete(id),
          database.failedSetups.delete(id),
        ])
      ),
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
