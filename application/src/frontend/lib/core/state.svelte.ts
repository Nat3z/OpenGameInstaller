import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { AppState, Settings } from '@/lib/state';
import { DEFAULT_SETTINGS } from '@/lib/state';

const logger = createLogger(LOGGER_PREFIXES.frontend);

// In-memory mirror of the main process's persisted state. Loaded once at boot
// so synchronous readers (download services, option views) never wait on IPC;
// every write goes through RPC first and updates the mirror from the reply.

export const settings: Settings = $state({ ...DEFAULT_SETTINGS });
export const appState: AppState = $state({
  installed: false,
  oobeRestartRequired: false,
  lastVersion: null,
});

function assign<A extends object>(target: A, source: A): void {
  Object.assign(target, source);
}

export function loadPersistedState() {
  return Effect.gen(function* () {
    const [nextSettings, nextAppState] = yield* Effect.all([
      electronRpc.state.getSettings(),
      electronRpc.state.getAppState(),
    ]);
    assign(settings, nextSettings);
    assign(appState, nextAppState);
  }).pipe(
    Effect.tapError((error) => logger.error('Failed to load state:', error))
  );
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return runFrontendEffect(
    electronRpc.state
      .updateSettings(patch)
      .pipe(Effect.tap((next) => Effect.sync(() => assign(settings, next))))
  );
}

export function updateAppState(patch: Partial<AppState>): Promise<AppState> {
  return runFrontendEffect(
    electronRpc.state
      .updateAppState(patch)
      .pipe(Effect.tap((next) => Effect.sync(() => assign(appState, next))))
  );
}
