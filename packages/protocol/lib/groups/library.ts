import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * A game in the library. Mirrors `LibraryInfo` from `@ogi-sdk/connect`; core
 * asserts the two stay assignable, so drift fails its typecheck.
 */
export const LibraryEntry = Schema.Struct({
  appID: Schema.Number,
  name: Schema.String,
  version: Schema.String,
  cwd: Schema.String,
  launchExecutable: Schema.String,
  launchArguments: Schema.optional(Schema.String),
  launchEnv: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
  capsuleImage: Schema.String,
  coverImage: Schema.String,
  titleImage: Schema.optional(Schema.String),
  storefront: Schema.String,
  addonsource: Schema.String,
  umu: Schema.optional(
    Schema.Struct({
      umuId: Schema.String.pipe(Schema.pattern(/^(steam|umu):\S+$/)),
      dllOverrides: Schema.optional(
        Schema.mutable(Schema.Array(Schema.String))
      ),
      protonVersion: Schema.optional(Schema.String),
      store: Schema.optional(Schema.String),
      winePrefixPath: Schema.optional(Schema.String),
      steamShortcutId: Schema.optional(Schema.Number),
      steamShortcutReaddId: Schema.optional(Schema.Number),
      steamShortcutLegacyExecutable: Schema.optional(Schema.String),
      steamShortcutLegacyName: Schema.optional(Schema.String),
    })
  ),
  redistributables: Schema.optional(
    Schema.mutable(
      Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))
    )
  ),
});
export type LibraryEntry = typeof LibraryEntry.Type;

export const AppID = Schema.Struct({ appID: Schema.Number });

/** One change to the library, pushed to `library.watch` subscribers. */
export const LibraryChange = Schema.Union(
  Schema.TaggedStruct('Saved', { entry: LibraryEntry }),
  Schema.TaggedStruct('Removed', { appID: Schema.Number }),
  /**
   * `managed`: core runs this session's addon hooks (it was started with
   * `library.launch`). Clients must not run hooks for managed sessions.
   */
  Schema.TaggedStruct('Launched', {
    appID: Schema.Number,
    managed: Schema.Boolean,
  }),
  Schema.TaggedStruct('Exited', {
    appID: Schema.Number,
    managed: Schema.Boolean,
  })
);
export type LibraryChange = typeof LibraryChange.Type;

export const LibraryGroup = group('library', {
  /** Every game, most recently launched first. */
  list: call({ params: Schema.Void, result: Schema.Array(LibraryEntry) }),
  get: call({ params: AppID, result: Schema.NullOr(LibraryEntry) }),
  /** Snapshot of `list`, then every change. */
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(LibraryEntry),
    update: LibraryChange,
  }),
  /** Runs pre hooks, starts the game; post hooks run when it exits. */
  launch: call({ params: AppID, result: Schema.Void }),
  // TODO(pass: library) implement once removal moves into core.
  uninstall: call({
    params: Schema.Struct({
      appID: Schema.Number,
      deleteFiles: Schema.Boolean,
    }),
    result: Schema.Void,
  }),
});
