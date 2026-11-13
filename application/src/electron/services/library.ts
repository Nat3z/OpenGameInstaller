import { LibraryStore } from '@ogi-sdk/core';
import { Effect, Layer } from 'effect';
import { Database } from '@/electron/services/database.js';

// The library itself (change feed, manifests, GameNotFound) lives in
// @ogi-sdk/core. This host only says where rows are stored: the app's sqlite.
export { Library, LibraryLive, type LibraryShape } from '@ogi-sdk/core';

/** Core's storage adapter, backed by the app database. */
export const LibraryStoreFromDatabase: Layer.Layer<
  LibraryStore,
  never,
  Database
> = Layer.effect(
  LibraryStore,
  Effect.map(Database, (database) => ({
    get: database.library.get,
    list: database.library.list,
    save: database.library.save,
    markLaunched: database.library.markLaunched,
    stageRemoval: database.library.stageRemoval,
  }))
);
