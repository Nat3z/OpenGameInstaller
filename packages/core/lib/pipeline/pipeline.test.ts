import { describe, expect, test } from 'bun:test';
import type { LibraryInfo, SetupCommandData } from '@ogi-sdk/connect';
import { AddonError, DownloadError } from '@ogi-sdk/errors';
import type { Download } from '@ogi-sdk/protocol';
import {
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Stream,
} from 'effect';
import { Downloads, DownloadsLive } from '../downloads/downloads';
import { EventsLive } from '../events/events';
import { LibraryLive, LibraryStore } from '../library/library';
import {
  AddonCalls,
  Debrid,
  type DownloadRecord,
  type DownloadRequest,
  DownloadStore,
  type EngineOutcome,
  Engines,
  Installer,
  PipelineConfig,
  type PipelineSettings,
  SetupFiles,
  SleepLock,
} from './adapters';
import { Pipeline, PipelineLive } from './pipeline';

// The pipeline against recording fakes of every adapter. Each test drives a
// download through the real state machine and checks what each adapter saw.

const direct: DownloadRequest = {
  name: 'Game',
  downloadType: 'direct',
  files: [{ name: 'game.zip', downloadURL: 'https://cdn/game.zip' }],
  addonSource: 'addon',
  storefront: 'steam',
};
const magnet: DownloadRequest = {
  name: 'Game',
  downloadType: 'magnet',
  filename: 'Game',
  downloadURL: 'magnet:?xt=1',
  addonSource: 'addon',
  storefront: 'steam',
};

type Options = {
  torrents?: PipelineSettings['torrents'];
  /** Outcome of the engine; `hold` never finishes until released. */
  engine?: EngineOutcome | 'hold';
  setupFails?: string;
  /** Version the addon's setup reports. */
  setupVersion?: string;
  /** Redistributables fail once, then succeed. */
  redistFails?: boolean;
  /** Saving a record at this step fails (a full disk, say). */
  saveFailsAt?: DownloadRecord['step'];
  records?: DownloadRecord[];
};

const harness = (options: Options = {}) => {
  const calls: string[] = [];
  const saved = new Map<string, DownloadRecord>(
    (options.records ?? []).map((record) => [record.id, record])
  );
  const library = new Map<number, LibraryInfo>();
  const sleep: boolean[] = [];
  const release = Effect.runSync(Deferred.make<EngineOutcome>());
  let setupFails = options.setupFails;
  let redistFails = options.redistFails;
  let engineCount = 0;

  const engineDone = (): Effect.Effect<EngineOutcome> =>
    options.engine === 'hold'
      ? Deferred.await(release)
      : Effect.succeed(options.engine ?? { _tag: 'Completed' });

  const adapters = Layer.mergeAll(
    Layer.succeed(PipelineConfig, {
      get: Effect.succeed({
        downloadRoot: '/dl',
        torrents: options.torrents ?? 'local',
      }),
    }),
    Layer.effect(
      Engines,
      Effect.map(Downloads, (downloads) => ({
        direct: (files: readonly { path: string }[]) =>
          Effect.gen(function* () {
            const id = `engine-${++engineCount}`;
            calls.push(`direct:${files.map((file) => file.path).join(',')}`);
            // Engines report under their own id, from their own fiber, once
            // started; the pipeline has aliased the id by then.
            const progress = downloads.report(id, {
              status: 'downloading',
              progress: 0.5,
            });
            return {
              id,
              done: Effect.zipRight(progress, engineDone()),
            };
          }),
        torrent: (kind: string, _link: string, folder: string) =>
          Effect.sync(() => {
            calls.push(`torrent:${kind}:${folder}`);
            return { id: `engine-${++engineCount}`, done: engineDone() };
          }),
        cancel: (id: string) => Effect.sync(() => calls.push(`cancel:${id}`)),
      }))
    ),
    Layer.succeed(Debrid, {
      resolve: (service) =>
        Effect.sync(() => {
          calls.push(`debrid:${service}`);
          return {
            zipped: service === 'torbox',
            files: [{ link: 'https://debrid/file', name: 'game.zip' }],
          };
        }),
    }),
    Layer.succeed(SetupFiles, {
      stageOldFiles: (folder) =>
        Effect.sync(() => {
          calls.push(`stage:${folder}`);
          return { staged: true, failed: 0 };
        }),
      revertOldFiles: (folder) =>
        Effect.sync(() => {
          calls.push(`revert:${folder}`);
          return true;
        }),
      discardOldFiles: (folder) =>
        Effect.sync(() => void calls.push(`discard:${folder}`)),
      contentRoot: (directory) => Effect.succeed(`${directory}/Game`),
      findArchive: (path, kind) =>
        Effect.succeed(kind === 'zip' ? `${path}/game.zip` : null),
      extract: (_, archive, output) =>
        Effect.sync(() => {
          calls.push(`extract:${archive}`);
          return output;
        }),
      remove: (paths) =>
        Effect.sync(() => calls.push(`remove:${paths.join(',')}`)),
    }),
    Layer.succeed(AddonCalls, {
      requestDownload: () => Effect.succeed(direct),
      setup: (_, data: SetupCommandData, onProgress) =>
        Effect.gen(function* () {
          calls.push(`setup:${data.path}`);
          yield* onProgress({ progress: 50, logs: ['unpacking'] });
          if (setupFails) {
            const message = setupFails;
            setupFails = undefined; // succeed on retry
            return yield* new AddonError({ message });
          }
          return {
            version: options.setupVersion ?? '1.0',
            cwd: data.path,
            launchExecutable: 'game.exe',
          };
        }),
    }),
    Layer.succeed(Installer, {
      install: (info) =>
        Effect.sync(() => {
          library.set(info.appID, info);
          calls.push(`install:${info.name}`);
          return options.redistFails
            ? ('needs-redistributables' as const)
            : ('installed' as const);
        }),
      update: () => Effect.sync(() => void calls.push('update')),
      redistributables: () =>
        Effect.sync(() => {
          calls.push('redist');
          const failed = redistFails;
          redistFails = false;
          return failed ? ('partial' as const) : ('success' as const);
        }),
    }),
    Layer.succeed(DownloadStore, {
      list: Effect.sync(() => [...saved.values()]),
      save: (record) =>
        record.step === options.saveFailsAt && record.error === undefined
          ? Effect.fail(new DownloadError({ message: 'disk full' }))
          : Effect.sync(() => void saved.set(record.id, record)),
      remove: (id) => Effect.sync(() => void saved.delete(id)),
    }),
    Layer.succeed(SleepLock, {
      set: (active) => Effect.sync(() => void sleep.push(active)),
    }),
    LibraryLive.pipe(
      Layer.provide(
        Layer.succeed(LibraryStore, {
          get: (appID) => Effect.succeed(library.get(appID) ?? null),
          list: Effect.sync(() => [...library.values()]),
          save: () => Effect.void,
          markLaunched: () => Effect.void,
          stageRemoval: () => Effect.die('unused'),
        })
      )
    ),
    EventsLive
  );

  const runtime = ManagedRuntime.make(
    PipelineLive.pipe(
      Layer.provideMerge(adapters),
      Layer.provideMerge(DownloadsLive)
    )
  );

  /** Resolves with the download's card once `done` holds for it. */
  const until = (
    id: string,
    done: (download: Download) => boolean
  ): Promise<Download> =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot, updates } = yield* (yield* Downloads).watch;
          const now = snapshot.find((d) => d.id === id);
          if (now && done(now)) return now;
          const next = yield* updates.pipe(
            Stream.filterMap((change) =>
              change._tag === 'Upsert' &&
              change.download.id === id &&
              done(change.download)
                ? Option.some(change.download)
                : Option.none()
            ),
            Stream.runHead
          );
          return Option.getOrThrow(next);
        })
      )
    );

  const pipeline = <A, E>(f: (p: Pipeline['Type']) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Pipeline, f));

  return { calls, saved, library, sleep, release, runtime, until, pipeline };
};

describe('pipeline', () => {
  test('direct download runs resolve → download → setup → install', async () => {
    const h = harness();
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct })
    );
    const done = await h.until(id, (d) => d.status === 'completed');

    expect(h.calls).toEqual([
      'direct:/dl/Game/game.zip',
      'setup:/dl/Game/',
      'install:Game',
    ]);
    expect(done.name).toBe('Game');
    expect(h.library.get(7)?.launchExecutable).toBe('game.exe');
    // Installed downloads leave nothing to resume.
    expect(h.saved.size).toBe(0);
    // Awake while working, asleep again after.
    expect(h.sleep).toEqual([true, false]);
    await h.runtime.dispose();
  });

  test('engine progress lands on the pipeline card, not a second one', async () => {
    const h = harness({ engine: 'hold' });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct })
    );
    const card = await h.until(id, (d) => d.progress === 0.5);
    const all = await h.runtime.runPromise(
      Effect.scoped(Effect.flatMap(Downloads, (d) => d.watch))
    );
    expect(card.status).toBe('downloading');
    expect(all.snapshot.map((d) => d.id)).toEqual([id]);
    await Effect.runPromise(Deferred.succeed(h.release, { _tag: 'Completed' }));
    await h.until(id, (d) => d.status === 'completed');
    await h.runtime.dispose();
  });

  test('torbox: magnet → debrid zip → extract → setup on the content root', async () => {
    const h = harness({ torrents: 'torbox' });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: magnet })
    );
    await h.until(id, (d) => d.status === 'completed');
    expect(h.calls).toEqual([
      'debrid:torbox',
      'direct:/dl/Game/Game.zip',
      'extract:/dl/Game/game.zip',
      // Removed only after the setup step is saved.
      'remove:/dl/Game/game.zip',
      'setup:/dl/Game/game/Game/',
      'install:Game',
    ]);
    await h.runtime.dispose();
  });

  test('an update stages old files before extracting the new ones', async () => {
    const h = harness({ torrents: 'torbox' });
    h.library.set(7, {
      appID: 7,
      name: 'Game',
      version: '0.9',
      cwd: '/dl/Game',
      launchExecutable: 'game.exe',
      capsuleImage: '',
      coverImage: '',
      storefront: 'steam',
      addonsource: 'addon',
    });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: magnet, update: { version: '1.0' } })
    );
    await h.until(id, (d) => d.status === 'completed');
    // Staging after extraction would move the extracted game into old_files.
    expect(h.calls.slice(0, 4)).toEqual([
      'debrid:torbox',
      'direct:/dl/Game/Game.zip',
      'stage:/dl/Game',
      'extract:/dl/Game/game.zip',
    ]);
    // The backup goes only once the update is applied.
    expect(h.calls.slice(-2)).toEqual(['update', 'discard:/dl/Game']);
    await h.runtime.dispose();
  });

  test('a mismatched update keeps its backup; dismissing restores it', async () => {
    const h = harness({ setupVersion: '0.5' });
    h.library.set(7, {
      appID: 7,
      name: 'Game',
      version: '0.9',
      cwd: '/dl/Game',
      launchExecutable: 'game.exe',
      capsuleImage: '',
      coverImage: '',
      storefront: 'steam',
      addonsource: 'addon',
    });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct, update: { version: '1.0' } })
    );
    const failed = await h.until(id, (d) => d.status === 'error');
    expect(failed.error).toContain('Version mismatch');
    // Neither applied nor thrown away: a retry still has the old install.
    expect(h.calls).not.toContain('update');
    expect(h.calls.some((call) => call.startsWith('discard'))).toBe(false);
    await h.pipeline((p) => p.dismiss(id));
    expect(h.calls.at(-1)).toBe('revert:/dl/Game');
    await h.runtime.dispose();
  });

  test('failed redistributables retry without setting up again', async () => {
    const h = harness({ redistFails: true });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct })
    );
    await h.until(id, (d) => d.status === 'error');
    expect(h.saved.get(id)?.step).toBe('redistributables');
    await h.pipeline((p) => p.retry(id));
    await h.until(id, (d) => d.status === 'completed');
    expect(h.calls.filter((call) => call.startsWith('setup'))).toHaveLength(1);
    expect(h.calls.filter((call) => call === 'redist')).toHaveLength(2);
    await h.runtime.dispose();
  });

  test('a step that fails to save leaves its inputs on disk', async () => {
    const h = harness({ torrents: 'torbox', saveFailsAt: 'setup' });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: magnet })
    );
    const failed = await h.until(id, (d) => d.status === 'error');
    expect(failed.error).toContain('disk full');
    // Extraction ran, but its archive stays: the saved step is still extract.
    expect(h.calls).toContain('extract:/dl/Game/game.zip');
    expect(h.calls.some((call) => call.startsWith('remove:'))).toBe(false);
    expect(h.saved.get(id)?.step).toBe('extract-zip');
    await h.runtime.dispose();
  });

  test('a transfer whose next save fails keeps its record and backup', async () => {
    const h = harness({ saveFailsAt: 'setup' });
    h.library.set(7, {
      appID: 7,
      name: 'Game',
      version: '0.9',
      cwd: '/dl/Game',
      launchExecutable: 'game.exe',
      capsuleImage: '',
      coverImage: '',
      storefront: 'steam',
      addonsource: 'addon',
    });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct, update: { version: '1.0' } })
    );
    await h.until(id, (d) => d.status === 'error');
    // Files are on disk and old ones staged: forgetting would strand both.
    expect(h.calls).toContain('stage:/dl/Game');
    await h.pipeline((p) => p.dismiss(id));
    expect(h.calls.at(-1)).toBe('revert:/dl/Game');
    await h.runtime.dispose();
  });

  test('a failed setup is kept on disk and retries from setup', async () => {
    const h = harness({ setupFails: 'addon crashed' });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct })
    );
    const failed = await h.until(id, (d) => d.status === 'error');
    expect(failed.error).toContain('addon crashed');
    expect(h.saved.get(id)?.step).toBe('setup');

    await h.pipeline((p) => p.retry(id));
    await h.until(id, (d) => d.status === 'completed');
    // The retry does not download again.
    expect(h.calls.filter((call) => call.startsWith('direct'))).toHaveLength(1);
    expect(h.saved.size).toBe(0);
    await h.runtime.dispose();
  });

  test('restored records resume setups and park downloads', async () => {
    const base = {
      appID: 7,
      request: direct,
      path: '/dl/Game/',
      files: [{ link: 'https://cdn/game.zip', path: '/dl/Game/game.zip' }],
      retryCount: 0,
      updatedAt: 0,
    };
    const h = harness({
      records: [
        { ...base, id: 'mid-setup', step: 'setup' },
        { ...base, id: 'mid-download', appID: 8, step: 'download' },
      ],
    });
    await h.until('mid-setup', (d) => d.status === 'completed');
    const parked = await h.until('mid-download', (d) => d.status === 'paused');
    expect(parked.name).toBe('Game');
    expect(h.calls).not.toContain('direct:/dl/Game/game.zip');

    // Resuming a parked download restarts its engine.
    expect(await h.pipeline((p) => p.restart('mid-download'))).toBe(true);
    await h.until('mid-download', (d) => d.status === 'completed');
    await h.runtime.dispose();
  });

  test('cancel stops the engine, deletes the files and the record', async () => {
    const h = harness({ engine: 'hold' });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: direct })
    );
    await h.until(id, (d) => d.status === 'downloading');
    expect(await h.pipeline((p) => p.cancel(id))).toBe(true);
    expect(h.calls).toContain('cancel:engine-1');
    expect(h.calls).toContain('remove:/dl/Game/game.zip');
    expect(h.saved.size).toBe(0);
    await h.runtime.dispose();
  });

  test('cancelling a local-torrent update keeps the installed game', async () => {
    const h = harness({ engine: 'hold' });
    h.library.set(7, {
      appID: 7,
      name: 'Game',
      version: '0.9',
      cwd: '/dl/Game',
      launchExecutable: 'game.exe',
      capsuleImage: '',
      coverImage: '',
      storefront: 'steam',
      addonsource: 'addon',
    });
    const id = await h.pipeline((p) =>
      p.enqueue({ appID: 7, request: magnet, update: { version: '1.0' } })
    );
    while (!h.calls.some((call) => call.startsWith('torrent:')))
      await Bun.sleep(1);
    expect(await h.pipeline((p) => p.cancel(id))).toBe(true);
    // The torrent's "file" is the game folder itself: never removed.
    expect(h.calls.some((call) => call.startsWith('remove:'))).toBe(false);
    await h.runtime.dispose();
  });
});
