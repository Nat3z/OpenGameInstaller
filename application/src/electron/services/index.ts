import { Events, EventsLive } from '@ogi-sdk/core';
import { Layer } from 'effect';
import {
  type Database,
  DatabaseLive,
  DatabaseTest,
} from '@/electron/services/database.js';
import {
  type Library,
  LibraryLive,
  LibraryStoreFromDatabase,
} from '@/electron/services/library.js';
import { type Settings, SettingsLive } from '@/electron/services/settings.js';

export { Events } from '@ogi-sdk/core';
export {
  Database,
  DatabaseTest,
  makeDatabase,
} from '@/electron/services/database.js';
export { Library, LibraryLive } from '@/electron/services/library.js';
export { Settings, SettingsLive } from '@/electron/services/settings.js';

/** Everything the main process runtime provides to application effects. */
export type AppServices = Database | Settings | Library | Events;

export const AppServicesLive: Layer.Layer<AppServices> = Layer.mergeAll(
  DatabaseLive,
  EventsLive,
  SettingsLive.pipe(Layer.provide(DatabaseLive)),
  LibraryLive.pipe(
    Layer.provide(LibraryStoreFromDatabase),
    Layer.provide(DatabaseLive)
  )
);

/** Same services over an injected database, for tests. */
export const AppServicesTest = (
  database: Parameters<typeof DatabaseTest>[0]
): Layer.Layer<AppServices> => {
  const databaseLayer = DatabaseTest(database);
  return Layer.mergeAll(
    databaseLayer,
    EventsLive,
    SettingsLive.pipe(Layer.provide(databaseLayer)),
    LibraryLive.pipe(
      Layer.provide(LibraryStoreFromDatabase),
      Layer.provide(databaseLayer)
    )
  );
};
