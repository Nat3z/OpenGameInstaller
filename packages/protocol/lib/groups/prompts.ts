import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * When core needs a human (addon `input-asked`, "close Steam?") it opens a
 * prompt. Every connected client sees it; the first `reply` wins and the
 * prompt closes for everyone. Served by core's `Prompts` service.
 */

export const Prompt = Schema.Union(
  Schema.TaggedStruct('Input', {
    id: Schema.String,
    title: Schema.String,
    description: Schema.String,
    /** Addon `ConfigurationFile`; opaque until config schemas are ported. */
    config: Schema.Unknown,
  }),
  Schema.TaggedStruct('Confirm', {
    id: Schema.String,
    title: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    confirmLabel: Schema.String,
    cancelLabel: Schema.String,
  })
);
export type Prompt = typeof Prompt.Type;

export const PromptChange = Schema.Union(
  Schema.TaggedStruct('Opened', { prompt: Prompt }),
  Schema.TaggedStruct('Closed', { id: Schema.String })
);

export const PromptAnswer = Schema.Union(
  Schema.TaggedStruct('Input', {
    values: Schema.Record({
      key: Schema.String,
      value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    }),
  }),
  Schema.TaggedStruct('Confirm', { confirmed: Schema.Boolean }),
  /** The user closed the prompt without answering. */
  Schema.TaggedStruct('Dismiss', {})
);
export type PromptAnswer = typeof PromptAnswer.Type;
export type PromptChange = typeof PromptChange.Type;

export const PromptsGroup = group('prompts', {
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(Prompt),
    update: PromptChange,
  }),
  reply: call({
    params: Schema.Struct({ id: Schema.String, answer: PromptAnswer }),
    /** false when another client answered first. */
    result: Schema.Struct({ accepted: Schema.Boolean }),
  }),
});
