import type { LibraryInfo } from '@ogi-sdk/connect';
import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {
  DownloadStatusAndInfo,
  FailedSetup,
  RedistributableInstall,
} from '@/lib/download-state.js';
import type { Theme, TorrentClient } from '@/lib/state.js';

// Source of truth for the SQLite schema. Edit here, then run `bun run db:generate`
// to regenerate the bundled migrations.

const json = <A>(name: string) => text(name, { mode: 'json' }).$type<A>();
const bool = (name: string) => integer(name, { mode: 'boolean' });

/** One row (id = 1) of typed user settings. */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  theme: text('theme').$type<Theme>().notNull().default('light'),
  fileDownloadLocation: text('file_download_location')
    .notNull()
    .default('./downloads'),
  torrentClient: text('torrent_client')
    .$type<TorrentClient>()
    .notNull()
    .default('webtorrent'),
  parallelChunkCount: integer('parallel_chunk_count').notNull().default(8),
  bandwidthLimit: integer('bandwidth_limit').notNull().default(0),
  steamCompatibilityTool: text('steam_compatibility_tool')
    .notNull()
    .default('proton_experimental'),
  addons: json<string[]>('addons').notNull().default(sql`'[]'`),
  marketplaceSources: json<string[]>('marketplace_sources')
    .notNull()
    .default(sql`'["https://ogi-marketplace.nat3z.com"]'`),
  debridApiKey: text('debrid_api_key').notNull().default(''),
  torboxApiKey: text('torbox_api_key').notNull().default(''),
  premiumizeApiKey: text('premiumize_api_key').notNull().default(''),
  alldebridApiKey: text('alldebrid_api_key').notNull().default(''),
  qbitHost: text('qbit_host').notNull().default('http://127.0.0.1'),
  qbitPort: text('qbit_port').notNull().default('8080'),
  qbitUsername: text('qbit_username').notNull().default('admin'),
  qbitPassword: text('qbit_password').notNull().default('admin'),
  disableSecretCheck: bool('disable_secret_check').notNull().default(false),
  clientSdkUrl: text('client_sdk_url')
    .notNull()
    .default('ws://127.0.0.1:7654'),
  steamGridDbApiKey: text('steam_grid_db_api_key').notNull().default(''),
});

/** One row (id = 1) of installation lifecycle flags. */
export const appState = sqliteTable('app_state', {
  id: integer('id').primaryKey(),
  installed: bool('installed').notNull().default(false),
  oobeRestartRequired: bool('oobe_restart_required').notNull().default(false),
  lastVersion: text('last_version'),
  legacyImportedAt: text('legacy_imported_at'),
});

/** Addon-defined configuration values, keyed per addon. */
export const addonConfig = sqliteTable(
  'addon_config',
  {
    addonId: text('addon_id').notNull(),
    key: text('key').notNull(),
    value: json<string | number | boolean>('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.addonId, table.key] })]
);

export const library = sqliteTable(
  'library',
  {
    appId: integer('app_id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    cwd: text('cwd').notNull(),
    launchExecutable: text('launch_executable').notNull(),
    launchArguments: text('launch_arguments'),
    launchEnv: json<Record<string, string>>('launch_env'),
    capsuleImage: text('capsule_image').notNull(),
    coverImage: text('cover_image').notNull(),
    titleImage: text('title_image'),
    storefront: text('storefront').notNull(),
    addonSource: text('addon_source').notNull(),
    umu: json<NonNullable<LibraryInfo['umu']>>('umu'),
    redistributables:
      json<NonNullable<LibraryInfo['redistributables']>>('redistributables'),
    /** Higher = launched more recently; new games start below every existing one. */
    recentRank: integer('recent_rank').notNull().default(0),
  },
  (table) => [index('library_recent_rank').on(table.recentRank)]
);

/** Library rows parked while a removal awaits confirmation; restored on crash. */
export const libraryRemovals = sqliteTable('library_removals', {
  appId: integer('app_id').primaryKey(),
  row: json<typeof library.$inferSelect>('row').notNull(),
});

export const downloads = sqliteTable('downloads', {
  id: text('id').primaryKey(),
  appId: integer('app_id').notNull(),
  status: text('status').notNull(),
  updatedAt: integer('updated_at').notNull(),
  downloadInfo: json<DownloadStatusAndInfo>('download_info').notNull(),
  redistributableInstall: json<RedistributableInstall>(
    'redistributable_install'
  ),
});

export const failedSetups = sqliteTable('failed_setups', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  downloadInfo: json<FailedSetup['downloadInfo']>('download_info').notNull(),
  setupData: json<FailedSetup['setupData']>('setup_data').notNull(),
  error: text('error').notNull(),
  should: text('should').$type<FailedSetup['should']>().notNull(),
});

export const requiredReadds = sqliteTable('required_readds', {
  appId: integer('app_id').primaryKey(),
  steamAppId: integer('steam_app_id'),
});

export const dismissedUpdates = sqliteTable('dismissed_updates', {
  appId: integer('app_id').primaryKey(),
  updateVersion: text('update_version').notNull(),
});

export const imageCache = sqliteTable('image_cache', {
  key: text('key').primaryKey(),
  mimeType: text('mime_type').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
  cachedAt: integer('cached_at').notNull(),
});
