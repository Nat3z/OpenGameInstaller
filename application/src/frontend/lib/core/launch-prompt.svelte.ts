/**
 * Promise-backed "Launch Anyway" prompt state shared by launch surfaces.
 * Must live in a `.svelte.ts` module for rune support.
 */
export function createLaunchPrompt() {
  let message = $state<string | null>(null);
  let resolver: ((proceed: boolean) => void) | null = null;

  return {
    get message() {
      return message;
    },
    request(error: string): Promise<boolean> {
      message = error;
      return new Promise((resolve) => {
        resolver = resolve;
      });
    },
    answer(proceed: boolean) {
      message = null;
      resolver?.(proceed);
      resolver = null;
    },
  };
}
