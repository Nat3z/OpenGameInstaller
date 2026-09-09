import { Layer } from 'effect';
import {
  type Database,
  DatabaseLive,
  DatabaseTest,
} from '@/electron/services/database.js';
import { type Library, LibraryLive } from '@/electron/services/library.js';
import { type Settings, SettingsLive } from '@/electron/services/settings.js';

export {
  Database,
  DatabaseTest,
  makeDatabase,
} from '@/electron/services/database.js';
export { Library, LibraryLive } from '@/electron/services/library.js';
export { Settings, SettingsLive } from '@/electron/services/settings.js';

/** Everything the main process runtime provides to application effects. */
export type AppServices = Database | Settings | Library;

export const AppServicesLive: Layer.Layer<AppServices> = Layer.mergeAll(
  DatabaseLive,
  SettingsLive.pipe(Layer.provide(DatabaseLive)),
  LibraryLive.pipe(Layer.provide(DatabaseLive))
);

/** Same services over an injected database, for tests. */
export const AppServicesTest = (
  database: Parameters<typeof DatabaseTest>[0]
): Layer.Layer<AppServices> => {
  const databaseLayer = DatabaseTest(database);
  return Layer.mergeAll(
    databaseLayer,
    SettingsLive.pipe(Layer.provide(databaseLayer)),
    LibraryLive.pipe(Layer.provide(databaseLayer))
  );
};
