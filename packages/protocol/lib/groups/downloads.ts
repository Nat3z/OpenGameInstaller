import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * Live downloads, from the moment an engine starts until the download is
 * cancelled or its setup finishes. Served by core's `Downloads` service.
 *
 * `enqueue` and `retrySetup` are not served yet: starting a download still
 * runs in the desktop renderer (debrid resolution, setup). See
 * packages/core/README.md, step "pipeline".
 */

export const DownloadStatus = Schema.Literal(
  'queued',
  'downloading',
  'paused',
  /** Engine is joining chunk files. */
  'merging',
  /** Post-download: extracting or moving files into place. */
  'extracting',
  'installing-redistributables',
  /** Files are on disk; setup may still be running in the desktop app. */
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
  isUpdate: Schema.optional(Schema.Boolean),
});
export type Download = typeof Download.Type;

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
  /**
   * Starts the full pipeline for a search result: resolve source, download,
   * extract, run addon setup, save to library. `result` is an addon
   * `SearchResult`; it stays opaque until addon payloads get schemas.
   */
  enqueue: call({
    params: Schema.Struct({
      appID: Schema.Number,
      addonSource: Schema.String,
      result: Schema.Unknown,
    }),
    result: ById,
  }),
  retrySetup: call({ params: ById, result: Schema.Void }),
});
