import {
  type Prompt,
  type PromptAnswer,
  type PromptChange,
  PromptsGroup,
} from '@ogi-sdk/protocol';
import {
  Context,
  Deferred,
  Effect,
  Layer,
  PubSub,
  Random,
  type Scope,
  Stream,
} from 'effect';
import { type Implementation, implement } from '../server/router';

/** A prompt as callers describe it; core assigns the id. */
export type PromptRequest = Prompt extends infer P
  ? P extends { id: string }
    ? Omit<P, 'id'>
    : never
  : never;

/**
 * Asks a human something and waits for the answer. Every connected client
 * (and the host's own UI) sees the prompt; the first answer wins and the
 * prompt closes everywhere. If the asking fiber is interrupted, the prompt
 * closes with no answer.
 */
export type PromptsShape = {
  readonly ask: (request: PromptRequest) => Effect.Effect<PromptAnswer>;
  /** Returns false when the prompt is gone (already answered or cancelled). */
  readonly reply: (id: string, answer: PromptAnswer) => Effect.Effect<boolean>;
  /** Open prompts plus every open/close from now on. */
  readonly watch: Effect.Effect<
    { snapshot: Prompt[]; updates: Stream.Stream<PromptChange> },
    never,
    Scope.Scope
  >;
};

export class Prompts extends Context.Tag('@ogi-sdk/core/Prompts')<
  Prompts,
  PromptsShape
>() {}

export const PromptsLive: Layer.Layer<Prompts> = Layer.effect(
  Prompts,
  Effect.gen(function* () {
    const open = new Map<
      string,
      { prompt: Prompt; answer: Deferred.Deferred<PromptAnswer> }
    >();
    const changes = yield* PubSub.unbounded<PromptChange>();

    const close = (id: string) =>
      Effect.suspend(() =>
        open.delete(id)
          ? PubSub.publish(changes, { _tag: 'Closed', id })
          : Effect.void
      ).pipe(Effect.asVoid);

    return {
      ask: (request) =>
        Effect.gen(function* () {
          const id = `prompt-${(yield* Random.nextInt).toString(36)}`;
          const prompt = { ...request, id } as Prompt;
          const answer = yield* Deferred.make<PromptAnswer>();
          open.set(id, { prompt, answer });
          yield* PubSub.publish(changes, { _tag: 'Opened', prompt });
          // Closes on answer and on interruption alike; close is a no-op if a
          // reply already removed it.
          return yield* Deferred.await(answer).pipe(Effect.ensuring(close(id)));
        }),
      reply: (id, answer) =>
        Effect.gen(function* () {
          const entry = open.get(id);
          if (!entry) return false;
          yield* close(id);
          return yield* Deferred.succeed(entry.answer, answer);
        }),
      watch: Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return {
          snapshot: [...open.values()].map((entry) => entry.prompt),
          updates: Stream.fromQueue(subscription),
        };
      }),
    };
  })
);

export const PromptsHandlers: Implementation<Prompts> = implement<
  typeof PromptsGroup,
  Prompts
>(PromptsGroup, {
  watch: () => Effect.flatMap(Prompts, (prompts) => prompts.watch),
  reply: ({ id, answer }) =>
    Effect.flatMap(Prompts, (prompts) => prompts.reply(id, answer)).pipe(
      Effect.map((accepted) => ({ accepted }))
    ),
});
