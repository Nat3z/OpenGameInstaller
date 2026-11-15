import type {
  LibraryInfo,
  SearchResult,
  SetupCommandData,
} from '@ogi-sdk/connect';
import { DownloadError, formatError, GameNotFound } from '@ogi-sdk/errors';
import {
  type DownloadStatus,
  DownloadsGroup,
  type FailedSetup,
} from '@ogi-sdk/protocol';
import {
  Context,
  Effect,
  FiberMap,
  Layer,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import {
  controlEngine,
  DownloadControl,
  Downloads,
} from '../downloads/downloads';
import { Events } from '../events/events';
import { Library } from '../library/library';
import { type Implementation, implement } from '../server/router';
import {
  AddonCalls,
  Debrid,
  type DebridService,
  type DownloadRecord,
  type DownloadRequest,
  DownloadStore,
  Engines,
  type FileJob,
  Installer,
  PipelineConfig,
  SetupFiles,
  SleepLock,
} from './adapters';
import {
  dedupeNames,
  downloadPath,
  folderOf,
  nameOf,
  sanitizeSegment,
} from './paths';

/**
 * The download pipeline: resolve → download → extract → addon setup →
 * library. One fiber per download. Each step is saved to the `DownloadStore`
 * before it runs, so a restart (or a crash) resumes from that step instead of
 * starting over, and a failure after the files are on disk becomes a failed
 * setup that `retry` picks back up.
 *
 * This replaces the renderer's DownloadManager, `lib/downloads/*`,
 * `lib/setup/*` and `lib/recovery/*`.
 */
export type PipelineShape = {
  readonly enqueue: (input: {
    readonly appID: number;
    readonly request: DownloadRequest;
    readonly update?: { readonly version: string };
  }) => Effect.Effect<string, DownloadError>;
  readonly retry: (id: string) => Effect.Effect<void, DownloadError>;
  /** Forgets a failed setup; refuses one that isn't failed (retried since). */
  readonly dismiss: (id: string) => Effect.Effect<void, DownloadError>;
  /** Restarts a download whose engine is gone (paused across a restart). */
  readonly restart: (id: string) => Effect.Effect<boolean>;
  /**
   * Stops a download for good and deletes what it wrote. Fails while the
   * addon's setup runs (it can't be stopped from core).
   */
  readonly cancel: (id: string) => Effect.Effect<boolean, DownloadError>;
  readonly failedSetups: Effect.Effect<
    { snapshot: FailedSetup[]; updates: Stream.Stream<FailedSetup[]> },
    never,
    Scope.Scope
  >;
};

export class Pipeline extends Context.Tag('@ogi-sdk/core/Pipeline')<
  Pipeline,
  PipelineShape
>() {}

/** Statuses that keep the machine awake. */
const BUSY: ReadonlySet<DownloadStatus> = new Set<DownloadStatus>([
  'resolving',
  'queued',
  'downloading',
  'merging',
  'extracting',
  'setting-up',
  'installing-redistributables',
]);

export type PipelineServices =
  | Downloads
  | Events
  | Library
  | Engines
  | Debrid
  | PipelineConfig
  | SetupFiles
  | AddonCalls
  | Installer
  | DownloadStore
  | SleepLock;

const newId = (): string => Math.random().toString(36).slice(2, 12);

const failure = (id: string, message: string): DownloadError =>
  new DownloadError({ message, downloadId: id });

const isTorrentType = (type: string): type is 'torrent' | 'magnet' =>
  type === 'torrent' || type === 'magnet';

const toFailed = (record: DownloadRecord): FailedSetup => ({
  id: record.id,
  name: record.request.name,
  appID: record.appID,
  error: record.error ?? '',
  retryCount: record.retryCount,
  timestamp: record.updatedAt,
});

export const PipelineLive: Layer.Layer<Pipeline, never, PipelineServices> =
  Layer.scoped(
    Pipeline,
    Effect.gen(function* () {
      const context = yield* Effect.context<PipelineServices>();
      const downloads = yield* Downloads;
      const events = yield* Events;
      const store = yield* DownloadStore;
      const engines = yield* Engines;
      const files = yield* SetupFiles;
      const fibers = yield* FiberMap.make<string>();
      const records = new Map<string, DownloadRecord>();
      /** What each record looked like at its last successful save. */
      const persisted = new Map<string, DownloadRecord>();
      const failed = yield* SubscriptionRef.make<FailedSetup[]>([]);

      const notify = (
        level: 'info' | 'success' | 'warning' | 'error',
        message: string
      ) =>
        events.publish({ _tag: 'Notification', id: newId(), level, message });

      const refreshFailed = Effect.suspend(() =>
        SubscriptionRef.set(
          failed,
          [...records.values()]
            .filter((record) => record.error !== undefined)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(toFailed)
        )
      );

      /**
       * Persists a record. Memory takes the new state first, even if the write
       * then fails: a failure handler must still know a transfer finished or
       * files were staged. A failed save fails the step, so nothing after it
       * (an archive delete, say) runs on its account.
       */
      const save = (record: DownloadRecord) =>
        Effect.suspend(() => {
          const stamped = { ...record, updatedAt: Date.now() };
          records.set(record.id, stamped);
          return store.save(stamped).pipe(
            Effect.tap(() =>
              Effect.sync(() => persisted.set(record.id, stamped))
            ),
            Effect.as(stamped)
          );
        }).pipe(Effect.tap(() => refreshFailed));

      const forget = (id: string) =>
        Effect.suspend(() => {
          records.delete(id);
          persisted.delete(id);
          return store.remove(id);
        }).pipe(Effect.zipRight(refreshFailed));

      const log = (id: string, ...lines: string[]) => downloads.log(id, lines);

      /** Puts the record's metadata and `status` on its card. */
      const show = (record: DownloadRecord, status: DownloadStatus) =>
        downloads.report(record.id, {
          status,
          name: record.request.name,
          appID: record.appID,
          addonSource: record.request.addonSource,
          capsuleImage: record.request.capsuleImage,
          coverImage: record.request.coverImage,
          isUpdate: record.update !== undefined,
          debrid: record.debrid,
          path: record.path || undefined,
          error: null,
        });

      // ---- resolve: a search result becomes file jobs ------------------------

      const debrided = (
        record: DownloadRecord,
        service: DebridService,
        request: SearchResult & { downloadType: 'torrent' | 'magnet' },
        folder: string
      ) =>
        Effect.gen(function* () {
          yield* show({ ...record, debrid: service }, 'resolving');
          yield* log(record.id, `Sending to ${service}...`);
          const result = yield* (yield* Debrid)
            .resolve(
              service,
              request.downloadType,
              request.downloadURL,
              request.name
            )
            .pipe(
              Effect.mapError((error) => failure(record.id, error.message))
            );
          const names = result.zipped
            ? [`${sanitizeSegment(request.filename || request.name)}.zip`]
            : dedupeNames(
                result.files.map((file) => sanitizeSegment(file.name))
              );
          const jobs: FileJob[] = result.files.map((file, index) => ({
            link: file.link,
            path: `${folder}${names[index]}`,
            // Debrid hosts throttle parallel chunks on one link.
            headers: { 'OGI-Parallel-Limit': '1' },
          }));
          return { ...record, debrid: service, files: jobs, path: folder };
        });

      const resolve = (record: DownloadRecord) =>
        Effect.gen(function* () {
          const settings = yield* (yield* PipelineConfig).get;
          let request: SearchResult = record.request;
          if (request.downloadType === 'request') {
            yield* show(record, 'resolving');
            request = yield* (yield* AddonCalls)
              .requestDownload(
                record.request.addonSource,
                record.appID,
                record.request
              )
              .pipe(
                Effect.mapError((error) => failure(record.id, error.message))
              );
          }
          const folder = downloadPath(
            settings.downloadRoot,
            record.request.name
          );
          // The resolved result replaces the request, keeping display fields.
          const resolved = {
            ...record,
            request: {
              ...record.request,
              ...request,
              name: record.request.name,
            },
          };
          switch (request.downloadType) {
            case 'direct':
              // Nothing to fetch would start an engine that never finishes.
              if (!request.files?.length)
                return yield* failure(
                  record.id,
                  'The addon returned a download with no files.'
                );
              return {
                ...resolved,
                path: folder,
                files: request.files.map((file) => ({
                  link: file.downloadURL,
                  path: downloadPath(
                    settings.downloadRoot,
                    record.request.name,
                    file.name
                  ),
                  headers: file.headers,
                })),
              };
            case 'torrent':
            case 'magnet':
              if (settings.torrents === 'disable')
                return yield* failure(
                  record.id,
                  'Torrenting is disabled in the settings.'
                );
              if (settings.torrents === 'local')
                return {
                  ...resolved,
                  path: folder,
                  files: [{ link: request.downloadURL, path: folder }],
                };
              return yield* debrided(
                resolved,
                settings.torrents,
                request,
                folder
              );
            case 'empty':
              return { ...resolved, path: folder, step: 'setup' as const };
            default:
              return yield* failure(
                record.id,
                `Unsupported download type: ${request.downloadType}`
              );
          }
        });

      // ---- download ----------------------------------------------------------

      /** True when bytes come from a local torrent client, not HTTP. */
      const isLocalTorrent = (record: DownloadRecord) =>
        !record.debrid && isTorrentType(record.request.downloadType);

      const download = (record: DownloadRecord) =>
        Effect.gen(function* () {
          // Starting and aliasing can't be interrupted apart: a cancel during
          // the handshake would otherwise leave an engine nobody can find.
          // It lands right after, and the engine is stopped with the fiber.
          const started = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const engine = isLocalTorrent(record)
                ? yield* engines.torrent(
                    record.request.downloadType as 'torrent' | 'magnet',
                    record.files[0]?.link ?? '',
                    record.path
                  )
                : yield* engines.direct(record.files, record.part);
              // From here the engine's progress shows on this card.
              yield* downloads.alias(engine.id, record.id);
              return engine;
            })
          );
          return yield* started.done.pipe(
            Effect.onInterrupt(() => engines.cancel(started.id))
          );
        });

      // ---- after the download: where the content really is --------------------

      const afterDownload = (downloaded: DownloadRecord) =>
        Effect.gen(function* () {
          // Before extraction, while the folder holds only old files and this
          // download: staging later would move the new content aside too.
          // The backup folder is saved *before* anything moves, so a crash
          // mid-move still knows where to restore from (reverting a folder
          // with no `old_files` does nothing).
          const intended = stagingFolder(downloaded);
          if (intended) yield* save({ ...downloaded, staged: intended });
          const record = {
            ...downloaded,
            staged: yield* stageOldFiles(downloaded),
          };
          if (record.debrid === 'torbox' || record.debrid === 'premiumize')
            return { ...record, step: 'extract-zip' as const };
          if (record.debrid === 'realdebrid' || record.debrid === 'alldebrid') {
            const rar = yield* files
              .findArchive(folderOf(record.path), 'rar')
              .pipe(Effect.orElseSucceed(() => null));
            if (rar) return { ...record, step: 'extract-rar' as const };
          }
          // Torrents land in a wrapper folder; hand the addon the real root.
          const path = isLocalTorrent(record)
            ? `${yield* files.contentRoot(folderOf(record.path)).pipe(Effect.orElseSucceed(() => folderOf(record.path)))}/`
            : record.path;
          return { ...record, path, step: 'setup' as const };
        });

      const extract = (record: DownloadRecord, kind: 'rar' | 'zip') =>
        Effect.gen(function* () {
          const archive =
            (yield* files
              .findArchive(folderOf(record.path), kind)
              .pipe(Effect.orElseSucceed(() => null))) ?? record.files[0]?.path;
          if (!archive)
            return yield* failure(record.id, `No ${kind} archive to extract`);
          yield* show(record, 'extracting');
          yield* log(record.id, `Extracting ${nameOf(archive)}...`);
          const output =
            kind === 'zip' ? archive.replace(/\.zip$/i, '') : folderOf(archive);
          // Extraction fails transiently while antivirus scans the archive.
          const extracted = yield* files
            .extract(record.id, archive, output)
            .pipe(
              Effect.retry({ times: 2 }),
              Effect.mapError((error) => failure(record.id, error.message))
            );
          // ZIPs commonly wrap everything in one folder.
          const root =
            kind === 'zip'
              ? yield* files
                  .contentRoot(extracted)
                  .pipe(Effect.orElseSucceed(() => extracted))
              : extracted;
          return {
            record: {
              ...record,
              path: `${root.replace(/[/\\]+$/, '')}/`,
              // A ZIP extracts into its own folder, which a cancel removes. A
              // RAR extracts beside its parts, where an update's `old_files`
              // may also live, so that folder is left alone.
              extracted: kind === 'zip' ? output : undefined,
              step: 'setup' as const,
            },
            archive,
          };
        });

      // ---- setup ---------------------------------------------------------------

      const setupData = (
        record: DownloadRecord,
        current: LibraryInfo | null
      ): SetupCommandData => {
        const request = record.request;
        const base = {
          path: record.path,
          type: request.downloadType as 'direct' | 'torrent' | 'magnet',
          name: request.name,
          usedRealDebrid: record.debrid !== undefined,
          clearOldFilesBeforeUpdate: request.clearOldFilesBeforeUpdate,
          appID: record.appID,
          storefront: request.storefront,
          // Every HTTP-fetched file (direct or via debrid), as the renderer
          // sent; a local torrent's files are the client's, not ours.
          multiPartFiles: isLocalTorrent(record)
            ? []
            : record.files.map((file, index) => ({
                name:
                  (request.downloadType === 'direct'
                    ? request.files?.[index]?.name
                    : undefined) ?? nameOf(file.path),
                path: file.path,
                downloadURL: file.link,
                headers: file.headers,
              })),
          manifest: request.manifest ?? {},
        };
        return record.update && current
          ? { ...base, for: 'update', currentLibraryInfo: current }
          : { ...base, for: 'game' };
      };

      /**
       * Moves an update's existing files aside (unless the addon asked for an
       * in-place update). A dirty stage is reverted immediately: retrying on a
       * half-moved folder would be worse than no backup.
       */
      /** Where an update's old files go, or undefined when it keeps them. */
      const stagingFolder = (record: DownloadRecord) =>
        !record.update || record.request.clearOldFilesBeforeUpdate === false
          ? undefined
          : folderOf(record.path);

      const stageOldFiles = (record: DownloadRecord) =>
        Effect.gen(function* () {
          const folder = stagingFolder(record);
          if (!folder) return undefined;
          yield* log(record.id, 'Moving old files to old_files');
          const keep = [
            ...record.files.map((file) => nameOf(file.path)),
            nameOf(record.path),
            ...(isLocalTorrent(record)
              ? [`${nameOf(record.path)}.torrent`]
              : []),
          ];
          const result = yield* files
            .stageOldFiles(folder, keep)
            .pipe(Effect.orElseSucceed(() => ({ staged: true, failed: 1 })));
          if (result.failed > 0) {
            yield* files.revertOldFiles(folder).pipe(Effect.ignore);
            return undefined;
          }
          return result.staged ? folder : undefined;
        });

      /**
       * Whether removing `path` would take an update's installed game (or its
       * staged backup) with it: the same folder, or one that contains it.
       */
      const holdsInstall = (path: string, record: DownloadRecord) => {
        if (!record.update) return false;
        const folder = (record.staged ?? folderOf(record.path)).replace(
          /[/\\]+$/,
          ''
        );
        const target = path.replace(/[/\\]+$/, '');
        return folder === target || folder.startsWith(`${target}/`);
      };

      /** Puts staged old files back (an update that did not finish). */
      const restoreOldFiles = (record: DownloadRecord) =>
        record.staged
          ? files.revertOldFiles(record.staged).pipe(Effect.ignore)
          : Effect.void;

      const setup = (record: DownloadRecord) =>
        Effect.gen(function* () {
          const installer = yield* Installer;
          const current = record.update
            ? yield* (yield* Library)
                .get(record.appID)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
          if (record.update && !current)
            return yield* new GameNotFound({ gameId: record.appID });

          yield* show(record, 'setting-up');
          yield* downloads.report(record.id, { progress: 0, speed: 0 });
          const result = yield* (yield* AddonCalls).setup(
            record.request.addonSource,
            setupData(record, current),
            (progress) =>
              downloads
                .report(record.id, {
                  progress: progress.progress / 100,
                })
                .pipe(
                  Effect.zipRight(downloads.setLogs(record.id, progress.logs))
                )
          );

          if (record.update) {
            if (result.version !== record.update.version)
              return yield* failure(
                record.id,
                `Version mismatch: expected ${record.update.version}, got ${result.version}`
              );
            yield* installer.update(
              record.appID,
              result,
              record.request.addonSource
            );
            // Only now is the old install dead weight.
            if (record.staged)
              yield* files.discardOldFiles(record.staged).pipe(Effect.ignore);
            yield* notify(
              'success',
              `Updated ${record.request.name} to version ${result.version}`
            );
            return 'done' as const;
          }

          const outcome = yield* installer.install({
            ...result,
            name: record.request.name,
            appID: record.appID,
            storefront: record.request.storefront,
            addonsource: record.request.addonSource,
            capsuleImage: record.request.capsuleImage ?? '',
            coverImage: record.request.coverImage ?? '',
          });
          if (outcome === 'failed')
            return yield* failure(
              record.id,
              'The game could not be added to the library.'
            );
          if (outcome === 'needs-redistributables')
            return 'redistributables' as const;
          yield* notify(
            'success',
            `Setup complete for ${record.request.name}!`
          );
          return 'done' as const;
        });

      const redistributables = (record: DownloadRecord) =>
        Effect.gen(function* () {
          yield* show(record, 'installing-redistributables');
          const result = yield* (yield* Installer).redistributables(
            record.appID,
            record.id
          );
          // The game is already in the library; failing here keeps the record
          // at this step, so retrySetup reruns only the redistributables.
          if (result !== 'success')
            return yield* failure(
              record.id,
              `${record.request.name} was installed, but some redistributables failed.`
            );
          yield* notify(
            'success',
            `Setup complete for ${record.request.name}!`
          );
        });

      // ---- the state machine ------------------------------------------------

      /**
       * Runs a record from its saved step to the end. Failing after the files
       * are on disk keeps the record as a failed setup.
       */
      const run = (start: DownloadRecord): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          let record = start;
          yield* show(record, 'queued');
          if (record.step === 'download' && record.files.length === 0)
            record = yield* save(yield* resolve(record));

          // A crash during staging: the transfer is done and the backup folder
          // was saved before files moved. Put them back and stage again.
          if (record.step === 'download' && record.staged) {
            yield* restoreOldFiles(record);
            record = yield* save({ ...record, staged: undefined });
            record = yield* save(yield* afterDownload(record));
          }
          if (record.step === 'download') {
            const outcome = yield* download(record);
            if (outcome._tag === 'Cancelled') return;
            if (outcome._tag === 'Failed')
              return yield* failure(record.id, outcome.error);
            record = yield* save(yield* afterDownload(record));
          }
          if (record.step === 'extract-rar' || record.step === 'extract-zip') {
            const done = yield* extract(
              record,
              record.step === 'extract-rar' ? 'rar' : 'zip'
            );
            // Saved before the archive goes: a restart in between still finds
            // it and extracts again instead of failing on a missing archive.
            record = yield* save(done.record);
            yield* files.remove([done.archive]).pipe(Effect.ignore);
          }
          if (record.step === 'setup') {
            const next = yield* setup(record);
            if (next === 'redistributables')
              record = yield* save({ ...record, step: 'redistributables' });
          }
          if (record.step === 'redistributables')
            yield* redistributables(record);

          yield* forget(record.id);
          yield* downloads.report(record.id, {
            // A local torrent keeps seeding after setup.
            status: isLocalTorrent(record) ? 'seeding' : 'completed',
            progress: 1,
            speed: 0,
            phase: null,
          });
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const message = formatError(error) || 'Setup failed';
              const latest = records.get(start.id) ?? start;
              const saved = persisted.get(start.id) ?? start;
              yield* log(start.id, `Failed: ${message}`);
              yield* downloads.report(start.id, {
                status: 'error',
                error: message,
                speed: 0,
              });
              yield* notify('error', message);
              // Resume from the last step that reached disk (a later one whose
              // save failed may need inputs that step would remove). Only a
              // finished transfer moves past it, since its next step deletes
              // nothing; a staged backup is kept either way, so it can be
              // restored.
              const resume: DownloadRecord =
                saved.step === 'download' && latest.step !== 'download'
                  ? latest
                  : { ...saved, staged: latest.staged ?? saved.staged };
              // Failed before any file was written: nothing to retry from.
              if (resume.step === 'download') return yield* forget(start.id);
              // Best effort: if even this fails, the record on disk still
              // resumes from its last saved step after a restart.
              yield* save({ ...resume, error: message }).pipe(Effect.ignore);
            })
          ),
          Effect.provide(context)
        );

      const launch = (record: DownloadRecord) =>
        FiberMap.run(fibers, record.id, run(record));

      // ---- restore ---------------------------------------------------------------

      // Records outlive the process. A download that was mid-transfer comes
      // back paused (resuming restarts its engine); anything past the
      // transfer resumes on its own; failed setups wait for a retry.
      for (const record of yield* store.list) {
        records.set(record.id, record);
        if (record.error !== undefined) continue;
        // A `staged` download finished its transfer (`run` picks it up after
        // the transfer); only an unfinished transfer waits for a resume.
        if (
          record.step === 'download' &&
          record.files.length > 0 &&
          !record.staged
        )
          yield* show(record, 'paused');
        else yield* launch(record);
      }
      yield* refreshFailed;

      // ---- sleep lock ------------------------------------------------------------

      const sleepLock = yield* SleepLock;
      yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            const { snapshot, updates } = yield* downloads.watch;
            const statuses = new Map(snapshot.map((d) => [d.id, d.status]));
            let awake = false;
            const sync = Effect.suspend(() => {
              const busy = [...statuses.values()].some((s) => BUSY.has(s));
              if (busy === awake) return Effect.void;
              awake = busy;
              return sleepLock.set(busy);
            });
            yield* sync;
            yield* Stream.runForEach(updates, (change) => {
              if (change._tag === 'Upsert')
                statuses.set(change.download.id, change.download.status);
              else statuses.delete(change.id);
              return sync;
            });
          })
        )
      );

      return {
        enqueue: ({ appID, request, update }) =>
          Effect.gen(function* () {
            // One job per game: two would write the same paths, and cancelling
            // one could delete the other's files. A double-click or a second
            // client gets told, instead of a second job. (Checked and taken in
            // one synchronous step, since `save` puts it in `records` first.)
            for (const existing of records.values())
              if (existing.appID === appID)
                return yield* failure(
                  existing.id,
                  `${existing.request.name} is already downloading`
                );
            const id = newId();
            const record = yield* save({
              id,
              appID,
              request,
              update,
              path: '',
              files: [],
              step: 'download',
              retryCount: 0,
              updatedAt: Date.now(),
            }).pipe(
              Effect.tapError(() => Effect.sync(() => records.delete(id)))
            );
            yield* show(record, 'queued');
            yield* launch(record);
            return record.id;
          }),

        retry: (id) =>
          Effect.gen(function* () {
            const record = records.get(id);
            if (!record || record.error === undefined)
              return yield* failure(id, `No failed setup ${id}`);
            const next = yield* save({
              ...record,
              error: undefined,
              retryCount: record.retryCount + 1,
            });
            // Its card may have been cleared while it sat failed.
            yield* downloads.reopen(id);
            yield* launch(next);
          }),

        // A failed update keeps its backup for the retry; giving up on it puts
        // the old install back.
        dismiss: (id) =>
          Effect.gen(function* () {
            // A stale failed list (another client retried it) must not tear
            // down a setup that is writing files again.
            const current = records.get(id);
            if (
              current &&
              (current.error === undefined || (yield* FiberMap.has(fibers, id)))
            )
              return yield* failure(id, 'Only a failed setup can be dismissed');
            yield* FiberMap.remove(fibers, id);
            const record = records.get(id);
            if (record) yield* restoreOldFiles(record);
            yield* forget(id);
            yield* downloads.remove(id);
          }),

        restart: (id) =>
          Effect.gen(function* () {
            const record = records.get(id);
            if (!record || record.step !== 'download') return false;
            if (yield* FiberMap.has(fibers, id)) return false;
            yield* launch(record);
            return true;
          }),

        cancel: (id) =>
          Effect.gen(function* () {
            const record = records.get(id);
            if (!record) return false;
            // An addon's setup can't be stopped from here: its handler keeps
            // writing to the folder. Refuse instead of deleting under it (a
            // failed setup can still be dismissed once it ends).
            const card = yield* downloads.get(id);
            if (record.step === 'setup' && card?.status === 'setting-up')
              return yield* failure(
                id,
                'Setup is running in the addon and cannot be cancelled'
              );
            const engine = yield* downloads.engineOf(id);
            yield* FiberMap.remove(fibers, id);
            if (engine) yield* engines.cancel(engine);
            // The latest record: the fiber may have staged since `record`.
            const latest = records.get(id) ?? record;
            // Only what this transfer wrote. A local torrent's "file" is its
            // whole folder, which for an update is also the installed game and
            // its `old_files`; deleting it would leave nothing to restore.
            // Past setup the game is installed (and in the library): a cancel
            // then only stops the redistributables, it deletes nothing.
            const installed = latest.step === 'redistributables';
            const owned = installed
              ? []
              : [
                  ...latest.files.map((file) => file.path),
                  ...(latest.extracted ? [latest.extracted] : []),
                ].filter((path) => !holdsInstall(path, latest));
            if (owned.length > 0)
              yield* files.remove(owned).pipe(Effect.ignore);
            yield* restoreOldFiles(latest);
            yield* forget(id);
            yield* downloads.remove(id);
            yield* notify('info', `Cancelled download: ${record.request.name}`);
            return true;
          }),

        failedSetups: Effect.gen(function* () {
          // `changes` emits the current value first; the snapshot covers it.
          const updates = Stream.drop(failed.changes, 1);
          return { snapshot: yield* SubscriptionRef.get(failed), updates };
        }),
      };
    })
  );

/**
 * `downloads.*` methods that need the pipeline. `resume` tries the live
 * engine first and restarts it from the record when it is gone (paused
 * across a restart); `cancel` also deletes the files and the record.
 */
export const PipelineHandlers: Implementation<
  Pipeline | Downloads | DownloadControl
> = implement<typeof DownloadsGroup, Pipeline | Downloads | DownloadControl>(
  DownloadsGroup,
  {
    enqueue: ({ appID, addonSource, result, update }) =>
      Effect.flatMap(Pipeline, (pipeline) =>
        pipeline.enqueue({
          appID,
          update,
          request: { ...(result as DownloadRequest), addonSource },
        })
      ).pipe(Effect.map((id) => ({ id }))),
    resume: ({ id }) =>
      Effect.gen(function* () {
        if (yield* (yield* Pipeline).restart(id)) return;
        yield* controlEngine('resume', id);
      }),
    cancel: ({ id }) =>
      Effect.gen(function* () {
        if (yield* (yield* Pipeline).cancel(id)) return;
        // Not a pipeline download (an addon's raw file): stop the engine.
        yield* controlEngine('cancel', id);
      }),
    failedSetups: () =>
      Effect.flatMap(Pipeline, (pipeline) => pipeline.failedSetups),
    retrySetup: ({ id }) =>
      Effect.flatMap(Pipeline, (pipeline) => pipeline.retry(id)),
    dismissSetup: ({ id }) =>
      Effect.flatMap(Pipeline, (pipeline) => pipeline.dismiss(id)),
  }
);
