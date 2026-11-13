import type { LibraryInfo } from '@ogi-sdk/connect';
import { type DatabaseError, GameNotFound } from '@ogi-sdk/errors';
import type { LibraryChange } from '@ogi-sdk/protocol';
import { Context, Effect, Layer, PubSub, type Scope, Stream } from 'effect';
import { writeManifests } from './manifest';

/** Removal staged in storage: hidden until committed, restored on rollback. */
export type StagedRemoval = {
  readonly commit: () => void;
  readonly rollback: () => void;
};

/**
 * Adapter: where library rows live. The Electron host backs it with
 * better-sqlite3; a headless host could use bun:sqlite with the same SQL.
 * This is the only part of the library a host implements.
 */
export type LibraryStoreShape = {
  readonly get: (
    appID: number
  ) => Effect.Effect<LibraryInfo | null, DatabaseError>;
  readonly list: Effect.Effect<LibraryInfo[], DatabaseError>;
  readonly save: (info: LibraryInfo) => Effect.Effect<void, DatabaseError>;
  readonly markLaunched: (appID: number) => Effect.Effect<void, DatabaseError>;
  readonly stageRemoval: (
    appID: number
  ) => Effect.Effect<StagedRemoval, DatabaseError>;
};

export class LibraryStore extends Context.Tag('@ogi-sdk/core/LibraryStore')<
  LibraryStore,
  LibraryStoreShape
>() {}

/** The game library, most recently launched first. */
export type LibraryShape = {
  readonly get: (
    appID: number
  ) => Effect.Effect<LibraryInfo | null, DatabaseError>;
  /** Fails with `GameNotFound` instead of returning null. */
  readonly require: (
    appID: number
  ) => Effect.Effect<LibraryInfo, DatabaseError | GameNotFound>;
  readonly list: Effect.Effect<LibraryInfo[], DatabaseError>;
  /** Also mirrors the entry into the game folder's manifest, in the background. */
  readonly save: (info: LibraryInfo) => Effect.Effect<void, DatabaseError>;
  readonly markLaunched: (appID: number) => Effect.Effect<void, DatabaseError>;
  /** Hides the game until `commit`; fails when it is not in the library. */
  readonly stageRemoval: (
    appID: number
  ) => Effect.Effect<StagedRemoval, DatabaseError>;
  /** Report a running game's lifecycle to subscribers. */
  readonly notifyLaunched: (appID: number) => Effect.Effect<void>;
  readonly notifyExited: (appID: number) => Effect.Effect<void>;
  /**
   * Snapshot then live changes. Subscribes before reading, so nothing that
   * happens between the read and the first update is lost.
   */
  readonly watch: Effect.Effect<
    { snapshot: LibraryInfo[]; updates: Stream.Stream<LibraryChange> },
    DatabaseError,
    Scope.Scope
  >;
};

export class Library extends Context.Tag('@ogi-sdk/core/Library')<
  Library,
  LibraryShape
>() {}

export const LibraryLive: Layer.Layer<Library, never, LibraryStore> =
  Layer.effect(
    Library,
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const changes = yield* PubSub.unbounded<LibraryChange>();
      const publish = (change: LibraryChange) =>
        PubSub.publish(changes, change).pipe(Effect.asVoid);

      return {
        get: store.get,
        require: (appID) =>
          store
            .get(appID)
            .pipe(
              Effect.flatMap((info) =>
                info
                  ? Effect.succeed(info)
                  : Effect.fail(new GameNotFound({ gameId: appID }))
              )
            ),
        list: store.list,
        save: (info) =>
          store.save(info).pipe(
            Effect.tap(() => publish({ _tag: 'Saved', entry: info })),
            // Forked so callers running synchronously never wait on the disk.
            Effect.tap(() =>
              Effect.forkDaemon(writeManifests(store.list, info.appID))
            )
          ),
        markLaunched: store.markLaunched,
        // The change is published on commit, not on staging, so a rolled-back
        // removal never flickers out of a subscriber's list.
        stageRemoval: (appID) =>
          store.stageRemoval(appID).pipe(
            Effect.map((removal) => ({
              commit: () => {
                removal.commit();
                Effect.runSync(publish({ _tag: 'Removed', appID }));
              },
              rollback: removal.rollback,
            }))
          ),
        notifyLaunched: (appID) => publish({ _tag: 'Launched', appID }),
        notifyExited: (appID) => publish({ _tag: 'Exited', appID }),
        watch: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* store.list;
          return { snapshot, updates: Stream.fromQueue(subscription) };
        }),
      };
    })
  );
