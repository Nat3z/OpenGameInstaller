import { DownloadError } from '@ogi-sdk/errors';
import {
  type Download,
  type DownloadChange,
  DownloadsGroup,
} from '@ogi-sdk/protocol';
import { Context, Effect, Layer, PubSub, type Scope, Stream } from 'effect';
import { type Implementation, implement } from '../server/router';

/** What a host reports about a download; omitted fields keep their value. */
export type DownloadPatch = Partial<Omit<Download, 'id'>>;

/**
 * Live download state. Engines (and, until the pipeline moves, the desktop
 * renderer) report into it; protocol clients read it from `downloads.watch`.
 * Reports are merged, so each source only sends what it knows.
 */
export type DownloadsShape = {
  readonly report: (id: string, patch: DownloadPatch) => Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly log: (id: string, lines: readonly string[]) => Effect.Effect<void>;
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
    const changes = yield* PubSub.unbounded<DownloadChange>();
    const lines = yield* PubSub.unbounded<{ id: string; line: string }>();

    return {
      report: (id, patch) =>
        Effect.suspend(() => {
          // Drop undefined so a partial report never erases known fields.
          const defined = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined)
          );
          const next = { ...(downloads.get(id) ?? blank(id)), ...defined };
          downloads.set(id, next);
          return PubSub.publish(changes, { _tag: 'Upsert', download: next });
        }).pipe(Effect.asVoid),
      remove: (id) =>
        Effect.suspend(() => {
          logLines.delete(id);
          return downloads.delete(id)
            ? PubSub.publish(changes, { _tag: 'Removed', id })
            : Effect.void;
        }).pipe(Effect.asVoid),
      log: (id, newLines) =>
        Effect.suspend(() => {
          logLines.set(id, [...(logLines.get(id) ?? []), ...newLines]);
          return PubSub.publishAll(
            lines,
            newLines.map((line) => ({ id, line }))
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

const control =
  (action: keyof DownloadControlShape) =>
  ({ id }: { id: string }) =>
    Effect.gen(function* () {
      const download = yield* Effect.flatMap(Downloads, (d) => d.get(id));
      if (!download) {
        return yield* Effect.fail(
          new DownloadError({ message: `No download ${id}`, downloadId: id })
        );
      }
      yield* (yield* DownloadControl)[action](id);
    });

export const DownloadsHandlers: Implementation<Downloads | DownloadControl> =
  implement<typeof DownloadsGroup, Downloads | DownloadControl>(
    DownloadsGroup,
    {
      watch: () => Effect.flatMap(Downloads, (downloads) => downloads.watch),
      logs: ({ id }) =>
        Effect.flatMap(Downloads, (downloads) => downloads.logs(id)),
      pause: control('pause'),
      resume: control('resume'),
      cancel: control('cancel'),
      // enqueue / retrySetup: MethodNotFound until the pipeline moves.
    }
  );
