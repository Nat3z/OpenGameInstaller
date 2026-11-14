import { type AppEvent, EventsGroup } from '@ogi-sdk/protocol';
import {
  Context,
  Effect,
  Layer,
  PubSub,
  type Queue,
  type Scope,
  Stream,
} from 'effect';
import { type Implementation, implement } from '../server/router';

/**
 * Fire-and-forget notices for every connected client (and, in the Electron
 * host, the renderer's IPC channels). Producers call `publish`; nothing in
 * core or the host talks to a window directly.
 */
export type EventsShape = {
  /** Synchronous for an unbounded PubSub, so publish order is delivery order. */
  readonly publish: (event: AppEvent) => Effect.Effect<void>;
  /**
   * A queue receiving every event published after this returns. Lives as
   * long as the scope, so subscribe first, then start anything that publishes.
   */
  readonly subscribe: Effect.Effect<
    Queue.Dequeue<AppEvent>,
    never,
    Scope.Scope
  >;
};

export class Events extends Context.Tag('@ogi-sdk/core/Events')<
  Events,
  EventsShape
>() {}

export const EventsLive: Layer.Layer<Events> = Layer.effect(
  Events,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<AppEvent>();
    return {
      publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub),
    };
  })
);

export const EventsHandlers: Implementation<Events> = implement<
  typeof EventsGroup,
  Events
>(EventsGroup, {
  watch: () =>
    Effect.flatMap(Events, (events) => events.subscribe).pipe(
      Effect.map((queue) => ({
        snapshot: [],
        updates: Stream.fromQueue(queue),
      }))
    ),
});
