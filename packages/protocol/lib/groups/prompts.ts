import { Schema } from 'effect';
import { call, group, stream } from '../define';

/**
 * DRAFT: no server implements this group yet.
 *
 * When core needs a human (addon `input-asked`, "close Steam?", root password
 * for redistributables) it opens a prompt. Every connected client sees it;
 * the first `reply` wins and the prompt is removed for everyone.
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
    confirmLabel: Schema.String,
    cancelLabel: Schema.String,
  }),
  Schema.TaggedStruct('Secret', {
    id: Schema.String,
    title: Schema.String,
    message: Schema.String,
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
  Schema.TaggedStruct('Secret', { value: Schema.String }),
  Schema.TaggedStruct('Dismiss', {})
);

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
