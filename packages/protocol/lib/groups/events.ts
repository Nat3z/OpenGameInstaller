import { Schema } from 'effect';
import { group, stream } from '../define';

/**
 * Fire-and-forget notices that are not part of any state (toasts, "addons
 * started"). State changes belong on the owning group's `watch` instead, so
 * download progress lives on `downloads.watch`, not here.
 */

const GameId = { appID: Schema.Number };

export const AppEvent = Schema.Union(
  Schema.TaggedStruct('Notification', {
    id: Schema.String,
    level: Schema.Literal('info', 'success', 'warning', 'error'),
    message: Schema.String,
  }),
  // ---- addons -------------------------------------------------------------
  /** Every configured addon has been started. */
  Schema.TaggedStruct('AddonsStarted', {}),
  /** Every running addon has reported its manifest. */
  Schema.TaggedStruct('AddonManifestsReady', {}),
  /** `addon` is the addon link as stored in settings. */
  Schema.TaggedStruct('AddonUpdateAvailable', { addon: Schema.String }),
  Schema.TaggedStruct('AddonUpdated', { addon: Schema.String }),
  // ---- games ----------------------------------------------------------------
  /** A launch was asked for (Steam shortcut, single-instance relaunch). */
  Schema.TaggedStruct('GameLaunchRequested', GameId),
  Schema.TaggedStruct('GameLaunchFailed', GameId),
  // ---- app ------------------------------------------------------------------
  /** A startup migration asks the UI to run a one-off flow. */
  Schema.TaggedStruct('Migration', { name: Schema.String }),
  Schema.TaggedStruct('ShowChangelog', { version: Schema.String }),
  Schema.TaggedStruct('OobeLog', { line: Schema.String })
);
export type AppEvent = typeof AppEvent.Type;

export const EventsGroup = group('events', {
  /** Events have no state, so the snapshot is always empty. */
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(AppEvent),
    update: AppEvent,
  }),
});
