import { type AppEvent, EventsGroup } from '@ogi-sdk/protocol';
import { Context, Effect, Layer, PubSub, Stream } from 'effect';
import { type Implementation, implement } from '../server/router';

/**
 * Fire-and-forget notices for every connected client. Replaces the renderer
 * push channel (`webContents.send`) one event at a time; see core README.
 */
export type EventsShape = {
  readonly publish: (event: AppEvent) => Effect.Effect<void>;
  readonly subscribe: Stream.Stream<AppEvent>;
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
      subscribe: Stream.fromPubSub(pubsub),
    };
  })
);

export const EventsHandlers: Implementation<Events> = implement<
  typeof EventsGroup,
  Events
>(EventsGroup, {
  watch: () =>
    Effect.map(Events, (events) => ({
      snapshot: [],
      updates: events.subscribe,
    })),
});
