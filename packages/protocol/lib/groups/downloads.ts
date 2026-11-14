import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * Live downloads, from `enqueue` until the download is cancelled or cleared.
 * Served by core's `Downloads` service; core's pipeline drives each one
 * through resolve → download → extract → addon setup → library.
 */

export const DownloadStatus = Schema.Literal(
  /** Asking the addon (`request`) or a debrid service for the real files. */
  'resolving',
  'queued',
  'downloading',
  'paused',
  /** Engine is joining chunk files. */
  'merging',
  /** Post-download: extracting or moving files into place. */
  'extracting',
  /** The addon's `setup` is running. */
  'setting-up',
  'installing-redistributables',
  /** Setup finished; the game is in the library. */
  'completed',
  /** Torrent finished and is seeding. */
  'seeding',
  'error'
);
export type DownloadStatus = typeof DownloadStatus.Type;

export const Download = Schema.Struct({
  id: Schema.String,
  status: DownloadStatus,
  /** 0..1 */
  progress: Schema.Number,
  /** bytes per second */
  speed: Schema.Number,
  /** bytes; 0 until the engine knows */
  size: Schema.Number,
  queuePosition: Schema.optional(Schema.Number),
  part: Schema.optional(Schema.Number),
  totalParts: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  // Metadata, filled in once known (engines only know the files).
  name: Schema.optional(Schema.String),
  appID: Schema.optional(Schema.Number),
  addonSource: Schema.optional(Schema.String),
  capsuleImage: Schema.optional(Schema.String),
  coverImage: Schema.optional(Schema.String),
  isUpdate: Schema.optional(Schema.Boolean),
  /** `realdebrid`, `alldebrid`, `torbox`, `premiumize` when one resolved it. */
  debrid: Schema.optional(Schema.String),
  /** What is happening right now, e.g. `Extracting archive`. */
  phase: Schema.optional(Schema.String),
  /** Torrent upload ratio while seeding. */
  ratio: Schema.optional(Schema.Number),
  /** Per-redistributable state while they install. */
  redistributables: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'installing', 'completed', 'failed'),
      })
    )
  ),
});
export type Download = typeof Download.Type;

/** A setup that failed (or was cut off) and can be retried from disk. */
export const FailedSetup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  appID: Schema.Number,
  error: Schema.String,
  retryCount: Schema.Number,
  timestamp: Schema.Number,
});
export type FailedSetup = typeof FailedSetup.Type;

export const DownloadChange = Schema.Union(
  Schema.TaggedStruct('Upsert', { download: Download }),
  /** Cancelled, or finished and cleared. */
  Schema.TaggedStruct('Removed', { id: Schema.String })
);
export type DownloadChange = typeof DownloadChange.Type;

const ById = Schema.Struct({ id: Schema.String });

export const DownloadsGroup = group('downloads', {
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(Download),
    update: DownloadChange,
  }),
  /** Setup / extraction log lines for one download. */
  logs: stream({
    params: ById,
    snapshot: Schema.Array(Schema.String),
    update: Schema.String,
  }),
  pause: call({ params: ById, result: Schema.Void }),
  resume: call({ params: ById, result: Schema.Void }),
  cancel: call({ params: ById, result: Schema.Void }),
  /** Removes a finished (completed or failed) download from the list. */
  clear: call({ params: ById, result: Schema.Void }),
  /**
   * Starts the full pipeline for a search result: resolve source, download,
   * extract, run addon setup, save to library. Returns once the download is
   * on `downloads.watch`; the rest runs in core. `result` is the addon
   * `SearchResult` plus display fields; it stays opaque until addon payloads
   * get schemas.
   */
  enqueue: call({
    params: Schema.Struct({
      appID: Schema.Number,
      addonSource: Schema.String,
      result: Schema.Unknown,
      /** Install as an update of the library entry for `appID`. */
      update: Schema.optional(Schema.Struct({ version: Schema.String })),
    }),
    result: ById,
  }),
  /** Setups that can be retried, newest first. */
  failedSetups: stream({
    params: Schema.Void,
    snapshot: Schema.Array(FailedSetup),
    update: Schema.Array(FailedSetup),
  }),
  /** Retries a failed setup from what is on disk. */
  retrySetup: call({ params: ById, result: Schema.Void }),
  /** Forgets a failed setup without retrying. */
  dismissSetup: call({ params: ById, result: Schema.Void }),
});
