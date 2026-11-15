import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * DRAFT: no server implements this group yet. Shapes follow
 * `DownloadStatusAndInfo` in `application/src/lib/download-state.ts`, trimmed
 * to what a frontend renders. See packages/core/README.md, pass "downloads".
 */

export const DownloadStatus = Schema.Literal(
  'queued',
  'requesting',
  'downloading',
  'paused',
  'merging',
  'extracting',
  'setup',
  'installing-redistributables',
  'completed',
  'error',
  'cancelled'
);

export const Download = Schema.Struct({
  id: Schema.String,
  appID: Schema.Number,
  name: Schema.String,
  addonSource: Schema.String,
  capsuleImage: Schema.String,
  status: DownloadStatus,
  /** 0..1 */
  progress: Schema.Number,
  /** bytes per second */
  speed: Schema.Number,
  size: Schema.Number,
  queuePosition: Schema.optional(Schema.Number),
  part: Schema.optional(Schema.Number),
  totalParts: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  isUpdate: Schema.optional(Schema.Boolean),
});
export type Download = typeof Download.Type;

export const DownloadChange = Schema.Union(
  Schema.TaggedStruct('Upsert', { download: Download }),
  Schema.TaggedStruct('Removed', { id: Schema.String })
);

const ById = Schema.Struct({ id: Schema.String });

export const DownloadsGroup = group('downloads', {
  /**
   * Starts the full pipeline for a search result: resolve source, download,
   * extract, run addon setup, save to library. Returns the download id.
   * `result` is an addon `SearchResult`; it stays opaque until addon calls
   * move behind core.
   */
  enqueue: call({
    params: Schema.Struct({
      appID: Schema.Number,
      addonSource: Schema.String,
      result: Schema.Unknown,
    }),
    result: ById,
  }),
  pause: call({ params: ById, result: Schema.Void }),
  resume: call({ params: ById, result: Schema.Void }),
  cancel: call({ params: ById, result: Schema.Void }),
  retrySetup: call({ params: ById, result: Schema.Void }),
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(Download),
    update: DownloadChange,
  }),
  /** Setup log lines for one download. */
  logs: stream({
    params: ById,
    snapshot: Schema.Array(Schema.String),
    update: Schema.String,
  }),
});
