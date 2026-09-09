import { ConfigError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { getDatabase } from '@/electron/database/index.js';
import type { Settings } from '@/lib/state.js';

/** The full, typed settings row. Always present — defaults are seeded on open. */
export function getSettings(): Effect.Effect<Settings, ConfigError> {
  return Effect.try({
    try: () => getDatabase().getSettings(),
    catch: (cause) =>
      new ConfigError({
        message: `Failed to read settings: ${formatError(cause)}`,
        key: 'settings',
      }),
  });
}

export function getSteamCompatibilityTool(): Effect.Effect<
  string,
  ConfigError
> {
  // An empty value means the user cleared the tool; the stored default is
  // already 'proton_experimental'.
  return getSettings().pipe(
    Effect.map((settings) => settings.steamCompatibilityTool.trim())
  );
}
