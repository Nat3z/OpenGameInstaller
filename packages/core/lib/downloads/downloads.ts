import { DownloadError } from '@ogi-sdk/errors';
import {
  type Download,
  type DownloadChange,
  DownloadsGroup,
} from '@ogi-sdk/protocol';
import { Context, Effect, Layer, PubSub, type Scope, Stream } from 'effect';
import { type Implementation, implement } from '../server/router';

/**
 * What a host reports about a download. Omitted (undefined) fields keep their
 * value; `null` clears an optional field, e.g. `error: null` on a retry.
 */
export type DownloadPatch = {
  readonly [K in keyof Omit<Download, 'id'>]?: Download[K] | null;
};

/**
 * Live download state. Engines (and, until the pipeline moves, the desktop
 * renderer) report into it; protocol clients read it from `downloads.watch`.
 * Reports are merged, so each source only sends what it knows.
 */
export type DownloadsShape = {
  /**
   * Reports for `engineId` land on `id` from now on, so a pipeline download
   * shows as one card while engines come and go underneath it. Engine status
   * is only taken while it describes the transfer; the pipeline owns the rest.
   */
  readonly alias: (engineId: string, id: string) => Effect.Effect<void>;
  /** The engine currently moving bytes for `id`, if any. */
  readonly engineOf: (id: string) => Effect.Effect<string | undefined>;
  readonly report: (id: string, patch: DownloadPatch) => Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly log: (id: string, lines: readonly string[]) => Effect.Effect<void>;
  /**
   * Replaces the log with `lines`, publishing only what is new. Addons report
   * their whole log every time, so this is how their output is appended.
   */
  readonly setLogs: (
    id: string,
    lines: readonly string[]
  ) => Effect.Effect<void>;
  readonly get: (id: string) => Effect.Effect<Download | undefined>;
  readonly watch: Effect.Effect<
    { snapshot: Download[]; updates: Stream.Stream<DownloadChange> },
    never,
    Scope.Scope
  >;
  readonly logs: (
    id: string
  ) => Effect.Effect<
    { snapshot: string[]; updates: Stream.Stream<string> },
    never,
    Scope.Scope
  >;
};

export class Downloads extends Context.Tag('@ogi-sdk/core/Downloads')<
  Downloads,
  DownloadsShape
>() {}

/** Engine statuses that describe the transfer itself. */
const TRANSFER = new Set(['queued', 'downloading', 'paused', 'merging']);

const blank = (id: string): Download => ({
  id,
  status: 'queued',
  progress: 0,
  speed: 0,
  size: 0,
});

export const DownloadsLive: Layer.Layer<Downloads> = Layer.effect(
  Downloads,
  Effect.gen(function* () {
    const downloads = new Map<string, Download>();
    const logLines = new Map<string, string[]>();
    /** engine id → pipeline id, and back. */
    const aliases = new Map<string, string>();
    const engines = new Map<string, string>();
    const changes = yield* PubSub.unbounded<DownloadChange>();
    const lines = yield* PubSub.unbounded<{ id: string; line: string }>();

    const drop = (id: string) =>
      Effect.suspend(() => {
        logLines.delete(id);
        return downloads.delete(id)
          ? PubSub.publish(changes, { _tag: 'Removed', id })
          : Effect.void;
      }).pipe(Effect.asVoid);

    return {
      alias: (engineId, id) =>
        Effect.suspend(() => {
          aliases.set(engineId, id);
          engines.set(id, engineId);
          // Anything the engine reported before it was linked was a stray card.
          return drop(engineId);
        }),
      engineOf: (id) => Effect.sync(() => engines.get(id)),
      report: (reportedId, patch) =>
        Effect.suspend(() => {
          const id = aliases.get(reportedId) ?? reportedId;
          // Drop undefined so a partial report never erases known fields.
          const defined = Object.fromEntries(
            Object.entries(patch).filter(
              ([key, value]) =>
                value !== undefined &&
                !(
                  key === 'status' &&
                  id !== reportedId &&
                  !TRANSFER.has(value as string)
                )
            )
          );
          const next: Record<string, unknown> = {
            ...(downloads.get(id) ?? blank(id)),
            ...defined,
          };
          for (const [key, value] of Object.entries(next))
            if (value === null) delete next[key];
          downloads.set(id, next as Download);
          return PubSub.publish(changes, {
            _tag: 'Upsert',
            download: next as Download,
          });
        }).pipe(Effect.asVoid),
      remove: (reportedId) => drop(aliases.get(reportedId) ?? reportedId),
      log: (reportedId, newLines) =>
        Effect.suspend(() => {
          const id = aliases.get(reportedId) ?? reportedId;
          logLines.set(id, [...(logLines.get(id) ?? []), ...newLines]);
          return PubSub.publishAll(
            lines,
            newLines.map((line) => ({ id, line }))
          );
        }).pipe(Effect.asVoid),
      setLogs: (id, all) =>
        Effect.suspend(() => {
          const known = logLines.get(id) ?? [];
          // An addon's log only grows; a shorter one is a fresh run.
          const fresh =
            all.length >= known.length ? all.slice(known.length) : all;
          logLines.set(id, [...all]);
          return PubSub.publishAll(
            lines,
            fresh.map((line) => ({ id, line }))
          );
        }).pipe(Effect.asVoid),
      get: (id) => Effect.sync(() => downloads.get(id)),
      watch: Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return {
          snapshot: [...downloads.values()],
          updates: Stream.fromQueue(subscription),
        };
      }),
      logs: (id) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(lines);
          return {
            snapshot: [...(logLines.get(id) ?? [])],
            updates: Stream.fromQueue(subscription).pipe(
              Stream.filter((entry) => entry.id === id),
              Stream.map((entry) => entry.line)
            ),
          };
        }),
    };
  })
);

/**
 * Adapter: controls a running engine (direct, torrent, queue). The host
 * picks the engine that owns `id`.
 */
export type DownloadControlShape = {
  readonly pause: (id: string) => Effect.Effect<void, DownloadError>;
  readonly resume: (id: string) => Effect.Effect<void, DownloadError>;
  readonly cancel: (id: string) => Effect.Effect<void, DownloadError>;
};

export class DownloadControl extends Context.Tag(
  '@ogi-sdk/core/DownloadControl'
)<DownloadControl, DownloadControlShape>() {}

/** Sends `action` to whichever engine is moving bytes for `id` right now. */
export const controlEngine = (
  action: keyof DownloadControlShape,
  id: string
): Effect.Effect<void, DownloadError, Downloads | DownloadControl> =>
  Effect.gen(function* () {
    const downloads = yield* Downloads;
    if (!(yield* downloads.get(id)))
      return yield* new DownloadError({
        message: `No download ${id}`,
        downloadId: id,
      });
    const engine = yield* downloads.engineOf(id);
    yield* (yield* DownloadControl)[action](engine ?? id);
  });

/**
 * State and engine controls. The pipeline's methods (`enqueue`, `resume` and
 * `cancel` with cleanup, failed setups) are in `PipelineHandlers`; both
 * implement the `downloads` group and the server merges them per method.
 */
export const DownloadsHandlers: Implementation<Downloads | DownloadControl> =
  implement<typeof DownloadsGroup, Downloads | DownloadControl>(
    DownloadsGroup,
    {
      watch: () => Effect.flatMap(Downloads, (downloads) => downloads.watch),
      logs: ({ id }) =>
        Effect.flatMap(Downloads, (downloads) => downloads.logs(id)),
      pause: ({ id }) => controlEngine('pause', id),
      clear: ({ id }) =>
        Effect.flatMap(Downloads, (downloads) => downloads.remove(id)),
    }
  );
