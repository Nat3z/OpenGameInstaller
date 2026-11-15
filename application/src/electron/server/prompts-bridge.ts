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
): { replayInputs: () => void } => {
  const scope = Effect.runSync(Scope.make());
  const prompts = runElectronSync(
    Effect.flatMap(Prompts, (service) => service.watch).pipe(
      Scope.extend(scope)
    )
  );
  // Open native dialogs, so a prompt answered elsewhere closes its box too.
  const dialogs = new Map<string, AbortController>();
  // Prompts still open as far as the window knows; replay skips closed ones.
  const shown = new Set<string>();
  // Live changes and replays share one lane, so a replay can never re-show a
  // prompt whose `Closed` was already delivered.
  const lane = Effect.unsafeMakeSemaphore(1);
  const onChange = (
    change: PromptChange
  ): Effect.Effect<void, never, Prompts> => {
    // Answered elsewhere (or cancelled): drop the form, close the dialog.
    if (change._tag === 'Closed') {
      shown.delete(change.id);
      dialogs.get(change.id)?.abort();
      dialogs.delete(change.id);
      return Effect.promise(() => send('input-closed', { id: change.id }));
    }
    const prompt = change.prompt;
    shown.add(prompt.id);
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
      case 'Confirm': {
        // Registered now, before the fork: a `Closed` handled before the task
        // runs must still find it, or the dialog would open for a dead prompt.
        const abort = new AbortController();
        dialogs.set(prompt.id, abort);
        // Forked: a dialog must not block the next prompt from showing.
        return Effect.forkDaemon(
          Effect.promise(async () => {
            if (abort.signal.aborted) return undefined;
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
              // Not honored for parentless dialogs on macOS; a late answer
              // there is refused by `reply`.
              signal: abort.signal,
            };
            const { response } = window
              ? await dialog.showMessageBox(window, options)
              : await dialog.showMessageBox(options);
            return abort.signal.aborted ? undefined : response === 1;
          }).pipe(
            Effect.ensuring(Effect.sync(() => dialogs.delete(prompt.id))),
            Effect.flatMap((confirmed) =>
              confirmed === undefined
                ? Effect.void
                : Effect.flatMap(Prompts, (service) =>
                    service.reply(prompt.id, { _tag: 'Confirm', confirmed })
                  )
            )
          )
        ).pipe(Effect.asVoid);
      }
    }
  };
  forkElectronEffect(
    Stream.fromIterable(prompts.snapshot).pipe(
      Stream.map((prompt): PromptChange => ({ _tag: 'Opened', prompt })),
      Stream.concat(prompts.updates),
      Stream.runForEach((change) => lane.withPermits(1)(onChange(change)))
    )
  );
  return {
    // A reloaded renderer lost its forms; show the open inputs again. Confirm
    // dialogs are native, so they survived the reload.
    replayInputs: () =>
      forkElectronEffect(
        Effect.flatMap(Prompts, (service) => service.watch).pipe(
          Effect.flatMap(({ snapshot }) =>
            Effect.forEach(
              snapshot.filter((prompt) => prompt._tag === 'Input'),
              (prompt) =>
                lane.withPermits(1)(
                  Effect.suspend(() =>
                    shown.has(prompt.id)
                      ? onChange({ _tag: 'Opened', prompt })
                      : Effect.void
                  )
                ),
              { discard: true }
            )
          ),
          Effect.scoped
        )
      ),
  };
};

/** The renderer's modal submitted values for an `Input` prompt. */
export const answerInputPrompt = (
  id: string,
  values: Record<string, string | number | boolean>
): Effect.Effect<boolean, never, Prompts> =>
  Effect.flatMap(Prompts, (prompts) =>
    prompts.reply(id, { _tag: 'Input', values })
  );
