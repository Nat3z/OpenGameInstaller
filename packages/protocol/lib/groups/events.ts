import { Schema } from 'effect';
import { group, stream } from '../define';

/**
 * Fire-and-forget notices that are not part of any state (toasts, "addons
 * started"). State changes belong on the owning group's `watch` instead.
 *
 * Implemented: `events.watch` is served by core's `Events` service. Today
 * only `Notification` is published; the rest of `webContents.send` moves
 * here in the events pass.
 */

export const AppEvent = Schema.Union(
  Schema.TaggedStruct('Notification', {
    id: Schema.String,
    level: Schema.Literal('info', 'success', 'warning', 'error'),
    message: Schema.String,
  }),
  Schema.TaggedStruct('AddonsReady', {}),
  Schema.TaggedStruct('AddonUpdateAvailable', {
    addonId: Schema.String,
  })
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
