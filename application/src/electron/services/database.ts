import { DatabaseError } from '@ogi-sdk/errors';
import { Context, Effect, Layer } from 'effect';
import {
  type AppDatabase,
  getDatabase,
  type LibraryRemoval,
} from '@/electron/database/index.js';

/**
 * Effect-shaped access to the SQLite database. Every method maps a throwing
 * `AppDatabase` call into a typed `DatabaseError` so callers never leave the
 * error channel. The live layer resolves the database on each call, not at
 * layer construction, so the runtime can exist before `restoreBackup` runs.
 */
export type DatabaseShape = {
  readonly settings: {
    readonly get: Effect.Effect<
      AppDatabase['getSettings'] extends () => infer R ? R : never,
      DatabaseError
    >;
    readonly update: (
      patch: Parameters<AppDatabase['updateSettings']>[0]
    ) => Effect.Effect<
      ReturnType<AppDatabase['updateSettings']>,
      DatabaseError
    >;
  };
  readonly appState: {
    readonly get: Effect.Effect<
      ReturnType<AppDatabase['getAppState']>,
      DatabaseError
    >;
    readonly update: (
      patch: Parameters<AppDatabase['updateAppState']>[0]
    ) => Effect.Effect<
      ReturnType<AppDatabase['updateAppState']>,
      DatabaseError
    >;
  };
  readonly addonConfig: {
    readonly get: (
      addonId: string
    ) => Effect.Effect<
      ReturnType<AppDatabase['getAddonConfig']>,
      DatabaseError
    >;
    readonly set: (
      addonId: string,
      values: Parameters<AppDatabase['setAddonConfig']>[1]
    ) => Effect.Effect<void, DatabaseError>;
    readonly delete: (addonId: string) => Effect.Effect<void, DatabaseError>;
  };
  readonly library: {
    readonly get: (
      appID: number
    ) => Effect.Effect<ReturnType<AppDatabase['getGame']>, DatabaseError>;
    readonly has: (appID: number) => Effect.Effect<boolean, DatabaseError>;
    readonly list: Effect.Effect<
      ReturnType<AppDatabase['listGames']>,
      DatabaseError
    >;
    readonly save: (
      info: Parameters<AppDatabase['saveGame']>[0]
    ) => Effect.Effect<void, DatabaseError>;
    readonly markLaunched: (
      appID: number
    ) => Effect.Effect<void, DatabaseError>;
    readonly stageRemoval: (
      appID: number
    ) => Effect.Effect<LibraryRemoval, DatabaseError>;
  };
  readonly downloads: {
    readonly list: Effect.Effect<
      ReturnType<AppDatabase['listDownloads']>,
      DatabaseError
    >;
    readonly get: (
      id: string
    ) => Effect.Effect<ReturnType<AppDatabase['getDownload']>, DatabaseError>;
    readonly save: (
      record: Parameters<AppDatabase['saveDownload']>[0]
    ) => Effect.Effect<void, DatabaseError>;
    readonly delete: (id: string) => Effect.Effect<void, DatabaseError>;
  };
  readonly failedSetups: {
    readonly list: Effect.Effect<
      ReturnType<AppDatabase['listFailedSetups']>,
      DatabaseError
    >;
    readonly save: (
      setup: Parameters<AppDatabase['saveFailedSetup']>[0]
    ) => Effect.Effect<void, DatabaseError>;
    readonly delete: (id: string) => Effect.Effect<void, DatabaseError>;
  };
  readonly updateState: {
    readonly get: Effect.Effect<
      ReturnType<AppDatabase['getUpdateState']>,
      DatabaseError
    >;
    readonly set: (
      state: Parameters<AppDatabase['setUpdateState']>[0]
    ) => Effect.Effect<void, DatabaseError>;
  };
  readonly imageCache: {
    readonly get: (
      key: string
    ) => Effect.Effect<
      ReturnType<AppDatabase['getCachedImage']>,
      DatabaseError
    >;
    readonly put: (
      key: string,
      mimeType: string,
      bytes: Uint8Array
    ) => Effect.Effect<void, DatabaseError>;
  };
  /** Runs `operation` inside one SQLite transaction. */
  readonly transaction: <A>(
    operation: (database: AppDatabase) => A
  ) => Effect.Effect<A, DatabaseError>;
  readonly checkpoint: Effect.Effect<void, DatabaseError>;
};

export class Database extends Context.Tag('Database')<
  Database,
  DatabaseShape
>() {}

const attempt =
  (operation: string) =>
  <A>(run: (database: AppDatabase) => A, resolve: () => AppDatabase) =>
    Effect.try({
      try: () => run(resolve()),
      catch: (cause) =>
        new DatabaseError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation,
          cause,
        }),
    });

/** Builds the service over whatever `resolve` returns; tests pass an in-memory database. */
export const makeDatabase = (resolve: () => AppDatabase): DatabaseShape => {
  const call = <A>(operation: string, run: (database: AppDatabase) => A) =>
    attempt(operation)(run, resolve);
  return {
    settings: {
      get: call('settings.get', (db) => db.getSettings()),
      update: (patch) =>
        call('settings.update', (db) => db.updateSettings(patch)),
    },
    appState: {
      get: call('appState.get', (db) => db.getAppState()),
      update: (patch) =>
        call('appState.update', (db) => db.updateAppState(patch)),
    },
    addonConfig: {
      get: (addonId) =>
        call('addonConfig.get', (db) => db.getAddonConfig(addonId)),
      set: (addonId, values) =>
        call('addonConfig.set', (db) => db.setAddonConfig(addonId, values)),
      delete: (addonId) =>
        call('addonConfig.delete', (db) => db.deleteAddonConfig(addonId)),
    },
    library: {
      get: (appID) => call('library.get', (db) => db.getGame(appID)),
      has: (appID) => call('library.has', (db) => db.hasGame(appID)),
      list: call('library.list', (db) => db.listGames()),
      save: (info) => call('library.save', (db) => db.saveGame(info)),
      markLaunched: (appID) =>
        call('library.markLaunched', (db) => db.markGameLaunched(appID)),
      stageRemoval: (appID) =>
        call('library.stageRemoval', (db) => db.stageGameRemoval(appID)),
    },
    downloads: {
      list: call('downloads.list', (db) => db.listDownloads()),
      get: (id) => call('downloads.get', (db) => db.getDownload(id)),
      save: (record) => call('downloads.save', (db) => db.saveDownload(record)),
      delete: (id) => call('downloads.delete', (db) => db.deleteDownload(id)),
    },
    failedSetups: {
      list: call('failedSetups.list', (db) => db.listFailedSetups()),
      save: (setup) =>
        call('failedSetups.save', (db) => db.saveFailedSetup(setup)),
      delete: (id) =>
        call('failedSetups.delete', (db) => db.deleteFailedSetup(id)),
    },
    updateState: {
      get: call('updateState.get', (db) => db.getUpdateState()),
      set: (state) => call('updateState.set', (db) => db.setUpdateState(state)),
    },
    imageCache: {
      get: (key) => call('imageCache.get', (db) => db.getCachedImage(key)),
      put: (key, mimeType, bytes) =>
        call('imageCache.put', (db) => db.putCachedImage(key, mimeType, bytes)),
    },
    transaction: (operation) =>
      call('transaction', (db) => db.transaction(() => operation(db))),
    checkpoint: call('checkpoint', (db) => db.checkpoint()),
  };
};

/** Production layer: the process-wide database opened on first use. */
export const DatabaseLive: Layer.Layer<Database> = Layer.succeed(
  Database,
  makeDatabase(getDatabase)
);

/** Test layer over a caller-supplied (usually in-memory) database. */
export const DatabaseTest = (database: AppDatabase): Layer.Layer<Database> =>
  Layer.succeed(
    Database,
    makeDatabase(() => database)
  );
