import type { LibraryInfo } from '@ogi-sdk/connect';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { FailedSetup, PersistedDownload } from '@/lib/download-state.js';
import type {
  AddonConfigValues,
  AppState,
  Settings,
  UpdateState,
} from '@/lib/state.js';
import * as schema from './schema.js';

/** Any synchronous drizzle SQLite database (better-sqlite3 in Electron, bun:sqlite in tests). */
export type SqliteDatabase = BaseSQLiteDatabase<'sync', unknown>;

type LibraryRow = typeof schema.library.$inferSelect;

const toLibraryInfo = (row: LibraryRow): LibraryInfo => ({
  appID: row.appId,
  name: row.name,
  version: row.version,
  cwd: row.cwd,
  launchExecutable: row.launchExecutable,
  ...(row.launchArguments !== null && { launchArguments: row.launchArguments }),
  ...(row.launchEnv !== null && { launchEnv: row.launchEnv }),
  capsuleImage: row.capsuleImage,
  coverImage: row.coverImage,
  ...(row.titleImage !== null && { titleImage: row.titleImage }),
  storefront: row.storefront,
  addonsource: row.addonSource,
  ...(row.umu !== null && { umu: row.umu }),
  ...(row.redistributables !== null && {
    redistributables: row.redistributables,
  }),
});

const toLibraryRow = (info: LibraryInfo): Omit<LibraryRow, 'recentRank'> => ({
  appId: info.appID,
  name: info.name,
  version: info.version,
  cwd: info.cwd,
  launchExecutable: info.launchExecutable,
  launchArguments: info.launchArguments ?? null,
  launchEnv: info.launchEnv ?? null,
  capsuleImage: info.capsuleImage,
  coverImage: info.coverImage,
  titleImage: info.titleImage ?? null,
  storefront: info.storefront,
  addonSource: info.addonsource,
  umu: info.umu ?? null,
  redistributables: info.redistributables ?? null,
});

export type LibraryRemoval = { commit: () => void; rollback: () => void };

/**
 * Persistence layer over the SQLite database. Every read returns plain data
 * and every write is durable once the method returns.
 */
export class AppDatabase {
  constructor(
    readonly db: SqliteDatabase,
    migrationsFolder: string
  ) {
    // Same call drizzle's per-driver `migrate` helpers make; kept generic so
    // tests can run the real migrations against bun:sqlite.
    const migrator = db as unknown as {
      dialect: {
        migrate: (
          migrations: ReturnType<typeof readMigrationFiles>,
          session: unknown,
          config: { migrationsFolder: string }
        ) => void;
      };
      session: unknown;
    };
    migrator.dialect.migrate(
      readMigrationFiles({ migrationsFolder }),
      migrator.session,
      {
        migrationsFolder,
      }
    );
    this.transaction(() => {
      db.insert(schema.settings).values({ id: 1 }).onConflictDoNothing().run();
      db.insert(schema.appState).values({ id: 1 }).onConflictDoNothing().run();
      // A removal left staged by a crash is restored, never silently committed.
      for (const removal of db.select().from(schema.libraryRemovals).all()) {
        this.restoreRemoval(removal.appId);
      }
    });
  }

  transaction<A>(operation: () => A): A {
    return this.db.transaction(() => operation());
  }

  // ---- settings & app state -------------------------------------------------

  getSettings(): Settings {
    const { id: _id, ...row } = this.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.id, 1))
      .get()!;
    return row;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (Object.keys(patch).length > 0) {
      this.db
        .update(schema.settings)
        .set(patch)
        .where(eq(schema.settings.id, 1))
        .run();
    }
    return this.getSettings();
  }

  getAppState(): AppState {
    const row = this.db
      .select()
      .from(schema.appState)
      .where(eq(schema.appState.id, 1))
      .get()!;
    return {
      installed: row.installed,
      oobeRestartRequired: row.oobeRestartRequired,
      lastVersion: row.lastVersion,
    };
  }

  updateAppState(patch: Partial<AppState>): AppState {
    if (Object.keys(patch).length > 0) {
      this.db
        .update(schema.appState)
        .set(patch)
        .where(eq(schema.appState.id, 1))
        .run();
    }
    return this.getAppState();
  }

  legacyImportedAt(): string | null {
    return (
      this.db
        .select({ at: schema.appState.legacyImportedAt })
        .from(schema.appState)
        .where(eq(schema.appState.id, 1))
        .get()?.at ?? null
    );
  }

  markLegacyImported(): void {
    this.db
      .update(schema.appState)
      .set({ legacyImportedAt: new Date().toISOString() })
      .where(eq(schema.appState.id, 1))
      .run();
  }

  // ---- addon configuration --------------------------------------------------

  /** Returns null when the addon has never been configured. */
  getAddonConfig(addonId: string): AddonConfigValues | null {
    const rows = this.db
      .select({ key: schema.addonConfig.key, value: schema.addonConfig.value })
      .from(schema.addonConfig)
      .where(eq(schema.addonConfig.addonId, addonId))
      .all();
    if (rows.length === 0) return null;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /** Replaces the addon's whole configuration. */
  setAddonConfig(addonId: string, values: AddonConfigValues): void {
    this.transaction(() => {
      this.deleteAddonConfig(addonId);
      const rows = Object.entries(values).map(([key, value]) => ({
        addonId,
        key,
        value,
      }));
      if (rows.length > 0)
        this.db.insert(schema.addonConfig).values(rows).run();
    });
  }

  deleteAddonConfig(addonId: string): void {
    this.db
      .delete(schema.addonConfig)
      .where(eq(schema.addonConfig.addonId, addonId))
      .run();
  }

  // ---- library --------------------------------------------------------------

  getGame(appID: number): LibraryInfo | null {
    const row = this.db
      .select()
      .from(schema.library)
      .where(eq(schema.library.appId, appID))
      .get();
    return row ? toLibraryInfo(row) : null;
  }

  hasGame(appID: number): boolean {
    return (
      this.db
        .select({ appId: schema.library.appId })
        .from(schema.library)
        .where(eq(schema.library.appId, appID))
        .get() !== undefined
    );
  }

  /** Most recently launched first; never-launched games follow in insertion order. */
  listGames(): LibraryInfo[] {
    return this.db
      .select()
      .from(schema.library)
      .orderBy(desc(schema.library.recentRank), asc(schema.library.appId))
      .all()
      .map(toLibraryInfo);
  }

  /** Inserts or fully replaces a game, keeping its launch recency. */
  saveGame(info: LibraryInfo): void {
    const row = toLibraryRow(info);
    this.db
      .insert(schema.library)
      .values(row)
      .onConflictDoUpdate({ target: schema.library.appId, set: row })
      .run();
  }

  markGameLaunched(appID: number): void {
    this.db
      .update(schema.library)
      .set({
        recentRank: sql`(SELECT COALESCE(MAX(${schema.library.recentRank}), 0) + 1 FROM ${schema.library})`,
      })
      .where(eq(schema.library.appId, appID))
      .run();
  }

  /** Orders launch recency from most to least recent; unknown ids are ignored. */
  setRecentOrder(appIDs: number[]): void {
    this.transaction(() => {
      appIDs.forEach((appID, index) => {
        this.db
          .update(schema.library)
          .set({ recentRank: appIDs.length - index })
          .where(eq(schema.library.appId, appID))
          .run();
      });
    });
  }

  /**
   * Hides a game from the library until the removal is committed. A rollback
   * (or a crash before commit) restores it exactly as it was.
   */
  stageGameRemoval(appID: number): LibraryRemoval {
    this.transaction(() => {
      const row = this.db
        .select()
        .from(schema.library)
        .where(eq(schema.library.appId, appID))
        .get();
      if (!row) throw new Error(`Game ${appID} is not in the library`);
      this.db
        .insert(schema.libraryRemovals)
        .values({ appId: appID, row })
        .run();
      this.db
        .delete(schema.library)
        .where(eq(schema.library.appId, appID))
        .run();
    });
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.db
          .delete(schema.libraryRemovals)
          .where(eq(schema.libraryRemovals.appId, appID))
          .run();
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.restoreRemoval(appID);
      },
    };
  }

  private restoreRemoval(appID: number): void {
    this.transaction(() => {
      const removal = this.db
        .select()
        .from(schema.libraryRemovals)
        .where(eq(schema.libraryRemovals.appId, appID))
        .get();
      if (!removal) return;
      this.db
        .insert(schema.library)
        .values(removal.row)
        .onConflictDoNothing()
        .run();
      this.db
        .delete(schema.libraryRemovals)
        .where(eq(schema.libraryRemovals.appId, appID))
        .run();
    });
  }

  // ---- downloads & recoveries ----------------------------------------------

  listDownloads(): PersistedDownload[] {
    return this.db
      .select()
      .from(schema.downloads)
      .all()
      .map((row) => ({
        id: row.id,
        updatedAt: row.updatedAt,
        downloadInfo: row.downloadInfo,
        ...(row.redistributableInstall && {
          redistributableInstall: row.redistributableInstall,
        }),
      }));
  }

  getDownload(id: string): PersistedDownload | null {
    const row = this.db
      .select()
      .from(schema.downloads)
      .where(eq(schema.downloads.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      downloadInfo: row.downloadInfo,
      ...(row.redistributableInstall && {
        redistributableInstall: row.redistributableInstall,
      }),
    };
  }

  saveDownload(record: PersistedDownload): void {
    const row = {
      id: record.id,
      appId: record.downloadInfo.appID,
      status: record.downloadInfo.status,
      updatedAt: record.updatedAt,
      downloadInfo: record.downloadInfo,
      redistributableInstall: record.redistributableInstall ?? null,
    };
    this.db
      .insert(schema.downloads)
      .values(row)
      .onConflictDoUpdate({ target: schema.downloads.id, set: row })
      .run();
  }

  deleteDownload(id: string): void {
    this.db.delete(schema.downloads).where(eq(schema.downloads.id, id)).run();
  }

  listFailedSetups(): FailedSetup[] {
    return this.db.select().from(schema.failedSetups).all();
  }

  getFailedSetup(id: string): FailedSetup | null {
    return (
      this.db
        .select()
        .from(schema.failedSetups)
        .where(eq(schema.failedSetups.id, id))
        .get() ?? null
    );
  }

  saveFailedSetup(setup: FailedSetup): void {
    this.db
      .insert(schema.failedSetups)
      .values(setup)
      .onConflictDoUpdate({ target: schema.failedSetups.id, set: setup })
      .run();
  }

  deleteFailedSetup(id: string): void {
    this.db
      .delete(schema.failedSetups)
      .where(eq(schema.failedSetups.id, id))
      .run();
  }

  // ---- update state ---------------------------------------------------------

  getUpdateState(): UpdateState {
    return {
      requiredReadds: this.db
        .select()
        .from(schema.requiredReadds)
        .all()
        .map((row) => ({
          appID: row.appId,
          ...(row.steamAppId !== null && { steamAppId: row.steamAppId }),
        })),
      dismissedUpdates: this.db
        .select()
        .from(schema.dismissedUpdates)
        .all()
        .map((row) => ({ appID: row.appId, updateVersion: row.updateVersion })),
    };
  }

  setUpdateState(state: UpdateState): void {
    this.transaction(() => {
      this.db.delete(schema.requiredReadds).run();
      this.db.delete(schema.dismissedUpdates).run();
      if (state.requiredReadds.length > 0) {
        this.db
          .insert(schema.requiredReadds)
          .values(
            state.requiredReadds.map((entry) => ({
              appId: entry.appID,
              steamAppId: entry.steamAppId ?? null,
            }))
          )
          .onConflictDoNothing()
          .run();
      }
      if (state.dismissedUpdates.length > 0) {
        this.db
          .insert(schema.dismissedUpdates)
          .values(
            state.dismissedUpdates.map((entry) => ({
              appId: entry.appID,
              updateVersion: entry.updateVersion,
            }))
          )
          .onConflictDoNothing()
          .run();
      }
    });
  }

  // ---- image cache ----------------------------------------------------------

  getCachedImage(key: string): { mimeType: string; bytes: Uint8Array } | null {
    const row = this.db
      .select({
        mimeType: schema.imageCache.mimeType,
        bytes: schema.imageCache.bytes,
      })
      .from(schema.imageCache)
      .where(eq(schema.imageCache.key, key))
      .get();
    return row ?? null;
  }

  putCachedImage(key: string, mimeType: string, bytes: Uint8Array): void {
    const row = {
      key,
      mimeType,
      bytes: Buffer.from(bytes),
      cachedAt: Date.now(),
    };
    this.db
      .insert(schema.imageCache)
      .values(row)
      .onConflictDoUpdate({ target: schema.imageCache.key, set: row })
      .run();
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Folds the write-ahead log into the main file so a plain copy is complete. */
  checkpoint(): void {
    this.db.all(sql.raw('PRAGMA wal_checkpoint(TRUNCATE)'));
  }

  /** Writes a consistent copy of the database to `destination`. */
  backup(destination: string): void {
    this.db.run(sql`VACUUM INTO ${destination}`);
  }

  close(): void {
    (this.db as unknown as { $client: { close: () => void } }).$client.close();
  }
}
