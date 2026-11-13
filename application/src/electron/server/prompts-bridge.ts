import type { PromptChange } from '@ogi-sdk/protocol';
import { Effect, Scope, Stream } from 'effect';
import { type BrowserWindow, dialog } from 'electron';
import { forkElectronEffect, runElectronSync } from '@/electron/runtime.js';
import { Prompts } from '@/electron/services/index.js';

/**
 * Shows core prompts in the desktop UI, so this host answers them like any
 * other client (first answer wins):
 *
 * - `Input`   -> the renderer's existing `input-asked` modal, answered via
 *               `app.inputSend` (see `answerInputPrompt`)
 * - `Confirm` -> a native message box, the same one the Steam flow used
 *
 * Removed once the renderer subscribes to `prompts.watch` itself.
 */
export const showPromptsInWindow = (
  getWindow: () => BrowserWindow | null,
  send: (channel: string, ...args: unknown[]) => Promise<void>
): void => {
  const scope = Effect.runSync(Scope.make());
  const prompts = runElectronSync(
    Effect.flatMap(Prompts, (service) => service.watch).pipe(
      Scope.extend(scope)
    )
  );
  const onChange = (
    change: PromptChange
  ): Effect.Effect<void, never, Prompts> => {
    if (change._tag === 'Closed') return Effect.void;
    const prompt = change.prompt;
    switch (prompt._tag) {
      case 'Input':
        return Effect.promise(() =>
          send('input-asked', {
            id: prompt.id,
            config: prompt.config,
            name: prompt.title,
            description: prompt.description,
          })
        );
      case 'Confirm':
        // Forked: a dialog must not block the next prompt from showing.
        return Effect.forkDaemon(
          Effect.promise(async () => {
            const window = getWindow();
            const options = {
              type: 'warning' as const,
              title: prompt.title,
              message: prompt.message,
              detail: prompt.detail,
              buttons: [prompt.cancelLabel, prompt.confirmLabel],
              defaultId: 1,
              cancelId: 0,
              noLink: true,
            };
            const { response } = window
              ? await dialog.showMessageBox(window, options)
              : await dialog.showMessageBox(options);
            return response === 1;
          }).pipe(
            Effect.flatMap((confirmed) =>
              Effect.flatMap(Prompts, (service) =>
                service.reply(prompt.id, { _tag: 'Confirm', confirmed })
              )
            )
          )
        ).pipe(Effect.asVoid);
    }
  };
  forkElectronEffect(
    Stream.fromIterable(prompts.snapshot).pipe(
      Stream.map((prompt): PromptChange => ({ _tag: 'Opened', prompt })),
      Stream.concat(prompts.updates),
      Stream.runForEach(onChange)
    )
  );
};

/** The renderer's modal submitted values for an `Input` prompt. */
export const answerInputPrompt = (
  id: string,
  values: Record<string, string | number | boolean>
): Effect.Effect<boolean, never, Prompts> =>
  Effect.flatMap(Prompts, (prompts) =>
    prompts.reply(id, { _tag: 'Input', values })
  );
