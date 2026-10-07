import type { LibraryInfo } from '@ogi-sdk/connect';
import { type DatabaseError, GameNotFound } from '@ogi-sdk/errors';
import { Context, Effect, Layer } from 'effect';
import type { LibraryRemoval } from '@/electron/database/index.js';
import { writeManifests } from '@/electron/lib/library-manifest.js';
import { Database } from '@/electron/services/database.js';

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
  ) => Effect.Effect<LibraryRemoval, DatabaseError>;
};

export class Library extends Context.Tag('Library')<Library, LibraryShape>() {}

export const LibraryLive: Layer.Layer<Library, never, Database> = Layer.effect(
  Library,
  Effect.gen(function* () {
    const database = yield* Database;
    return {
      get: database.library.get,
      require: (appID) =>
        database.library
          .get(appID)
          .pipe(
            Effect.flatMap((info) =>
              info
                ? Effect.succeed(info)
                : Effect.fail(new GameNotFound({ gameId: appID }))
            )
          ),
      list: database.library.list,
      // Forked so callers running synchronously never wait on the disk.
      save: (info) =>
        database.library.save(info).pipe(
          Effect.tap(() =>
            Effect.forkDaemon(
              database.library.list.pipe(
                Effect.flatMap((games) => writeManifests(games, info.appID)),
                Effect.ignore
              )
            )
          ),
          Effect.asVoid
        ),
      markLaunched: database.library.markLaunched,
      stageRemoval: database.library.stageRemoval,
    };
  })
);
