import type {
  LibraryInfo,
  SearchResult,
  SetupCommandData,
  SetupEventResponse,
} from '@ogi-sdk/connect';
import type {
  AddonError,
  DebridError,
  DownloadError,
  FileSystemError,
  LibraryError,
} from '@ogi-sdk/errors';
import { Context, type Effect } from 'effect';

/**
 * What the pipeline needs from a host. Each tag says *what*, never *how*;
 * the Electron app implements them in `application/src/electron/server/`.
 * A headless bun host would implement the same tags over its own engines.
 */

// ---- the request --------------------------------------------------------

/** An addon search result plus the display fields the store page adds. */
export type DownloadRequest = SearchResult & {
  readonly addonSource: string;
  readonly capsuleImage?: string;
  readonly coverImage?: string;
  readonly storefront: string;
};

/** A file an engine should write. `headers` go on the HTTP request. */
export type FileJob = {
  readonly link: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
};

/** How an engine's download ended. Progress arrives through `Downloads`. */
export type EngineOutcome =
  | { readonly _tag: 'Completed' }
  | { readonly _tag: 'Failed'; readonly error: string }
  | { readonly _tag: 'Cancelled' };

// ---- engines ---------------------------------------------------------------

/**
 * Adapter: the byte movers. Each start returns the engine's id for the
 * download (its progress is reported to `Downloads` under that id) and an
 * effect that resolves when it ends.
 */
export type EnginesShape = {
  readonly direct: (
    files: readonly FileJob[],
    part?: number
  ) => Effect.Effect<StartedDownload, DownloadError>;
  readonly torrent: (
    kind: 'torrent' | 'magnet',
    link: string,
    folder: string
  ) => Effect.Effect<StartedDownload, DownloadError>;
  /** Stops an engine download for good (a user cancel, not a shutdown). */
  readonly cancel: (engineId: string) => Effect.Effect<void>;
};
export type StartedDownload = {
  readonly id: string;
  readonly done: Effect.Effect<EngineOutcome>;
};
export class Engines extends Context.Tag('@ogi-sdk/core/Engines')<
  Engines,
  EnginesShape
>() {}

// ---- debrid -----------------------------------------------------------------

/** A torrent or magnet turned into plain HTTP downloads by a debrid service. */
export type Debrided = {
  readonly files: readonly { link: string; name: string }[];
  /** Torbox / Premiumize hand back one zip of the whole torrent. */
  readonly zipped: boolean;
};

/**
 * Adapter: debrid services. `resolve` adds the torrent, waits until the
 * service has it, and returns direct links. Keys come from the host's
 * settings, so a missing key fails with a `DebridError` saying so.
 */
export type DebridShape = {
  readonly resolve: (
    service: DebridService,
    kind: 'torrent' | 'magnet',
    link: string,
    name: string
  ) => Effect.Effect<Debrided, DebridError>;
};
export type DebridService =
  | 'realdebrid'
  | 'alldebrid'
  | 'torbox'
  | 'premiumize';
export class Debrid extends Context.Tag('@ogi-sdk/core/Debrid')<
  Debrid,
  DebridShape
>() {}

// ---- settings -----------------------------------------------------------------

export type PipelineSettings = {
  /** Root folder new downloads go under. */
  readonly downloadRoot: string;
  /** `webtorrent` / `qbittorrent` keep torrents local; `disable` refuses them. */
  readonly torrents: 'local' | 'disable' | DebridService;
};
export type PipelineSettingsShape = {
  readonly get: Effect.Effect<PipelineSettings>;
};
export class PipelineConfig extends Context.Tag('@ogi-sdk/core/PipelineConfig')<
  PipelineConfig,
  PipelineSettingsShape
>() {}

// ---- files on disk ------------------------------------------------------------

/**
 * Adapter: the setup's filesystem steps. All paths are checked by the host
 * to sit under a download root before anything is moved or deleted.
 */
export type SetupFilesShape = {
  /** Moves everything but `keep` into `old_files`; reports failed moves. */
  readonly stageOldFiles: (
    directory: string,
    keep: readonly string[]
  ) => Effect.Effect<{ staged: boolean; failed: number }, FileSystemError>;
  readonly revertOldFiles: (
    directory: string
  ) => Effect.Effect<boolean, FileSystemError>;
  readonly discardOldFiles: (
    directory: string
  ) => Effect.Effect<void, FileSystemError>;
  /** Descends through folders with a single child folder. */
  readonly contentRoot: (
    directory: string
  ) => Effect.Effect<string, FileSystemError>;
  readonly findArchive: (
    path: string,
    kind: 'rar' | 'zip'
  ) => Effect.Effect<string | null, FileSystemError>;
  /**
   * Extracts, leaving the archive (the pipeline removes it once the next step
   * is saved, so a crash in between can still extract again). Progress goes to
   * `Downloads` under `id`.
   */
  readonly extract: (
    id: string,
    archive: string,
    outputDir: string
  ) => Effect.Effect<string, FileSystemError>;
  /** Removes what a download wrote, for a cancel. */
  readonly remove: (
    paths: readonly string[]
  ) => Effect.Effect<void, FileSystemError>;
};
export class SetupFiles extends Context.Tag('@ogi-sdk/core/SetupFiles')<
  SetupFiles,
  SetupFilesShape
>() {}

// ---- the addon's side -----------------------------------------------------

/** What an addon reports while a deferred call runs. */
export type AddonProgress = {
  readonly progress: number;
  readonly logs: readonly string[];
};

/**
 * Adapter: the two deferred addon calls the pipeline makes. Both may take
 * minutes and ask the user for input (through core `Prompts`).
 */
export type AddonCallsShape = {
  /** `request`-type results: the addon looks up the real files. */
  readonly requestDownload: (
    addonId: string,
    appID: number,
    result: DownloadRequest
  ) => Effect.Effect<SearchResult, AddonError>;
  readonly setup: (
    addonId: string,
    data: SetupCommandData,
    onProgress: (progress: AddonProgress) => Effect.Effect<void>
  ) => Effect.Effect<SetupEventResponse, AddonError>;
};
export class AddonCalls extends Context.Tag('@ogi-sdk/core/AddonCalls')<
  AddonCalls,
  AddonCallsShape
>() {}

// ---- installing -----------------------------------------------------------

export type InstallOutcome =
  | 'installed'
  /** Saved; redistributables still need installing into its prefix. */
  | 'needs-redistributables'
  | 'failed';

/**
 * Adapter: what happens once the addon says how to launch the game. The
 * Electron host saves it (configuring UMU and Steam on Linux) and installs
 * redistributables; another host might only save it.
 */
export type InstallerShape = {
  readonly install: (
    info: LibraryInfo & {
      redistributables?: SetupEventResponse['redistributables'];
    }
  ) => Effect.Effect<InstallOutcome, LibraryError>;
  readonly update: (
    appID: number,
    setup: SetupEventResponse,
    addonSource: string
  ) => Effect.Effect<void, LibraryError>;
  /** Installs a saved game's redistributables; progress goes to `Downloads`. */
  readonly redistributables: (
    appID: number,
    downloadId: string
  ) => Effect.Effect<'success' | 'partial' | 'failed', LibraryError>;
};
export class Installer extends Context.Tag('@ogi-sdk/core/Installer')<
  Installer,
  InstallerShape
>() {}

// ---- persistence ----------------------------------------------------------

/** Everything needed to pick a download back up after a restart. */
export type DownloadRecord = {
  readonly id: string;
  readonly appID: number;
  readonly request: DownloadRequest;
  readonly update?: { readonly version: string };
  /** Where the files land: a folder, or one file for single-file downloads. */
  readonly path: string;
  readonly files: readonly FileJob[];
  readonly debrid?: DebridService;
  /** The step to resume from. */
  readonly step: PipelineStep;
  readonly part?: number;
  /**
   * The folder whose old files were moved to its `old_files`: discarded once
   * the update fully succeeds, restored on any failure or cancel.
   */
  readonly staged?: string;
  /** The folder a ZIP was extracted into; removed on cancel. */
  readonly extracted?: string;
  readonly error?: string;
  readonly retryCount: number;
  readonly updatedAt: number;
};

/**
 * Where a download is in the pipeline. `download` resumes the engine;
 * `extract` and `setup` resume from what is already on disk.
 */
export type PipelineStep =
  | 'download'
  | 'extract-rar'
  | 'extract-zip'
  | 'setup'
  | 'redistributables';

/**
 * Adapter: durable download records. A record exists from enqueue until the
 * game is installed, so a restart (or crash) resumes it instead of losing it.
 * Records with an `error` are failed setups.
 */
export type DownloadStoreShape = {
  readonly list: Effect.Effect<readonly DownloadRecord[]>;
  readonly save: (record: DownloadRecord) => Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void>;
};
export class DownloadStore extends Context.Tag('@ogi-sdk/core/DownloadStore')<
  DownloadStore,
  DownloadStoreShape
>() {}

// ---- power ------------------------------------------------------------------

/** Adapter: keep the machine awake while anything is downloading or installing. */
export type SleepLockShape = {
  readonly set: (active: boolean) => Effect.Effect<void>;
};
export class SleepLock extends Context.Tag('@ogi-sdk/core/SleepLock')<
  SleepLock,
  SleepLockShape
>() {}
