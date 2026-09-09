import type { DatabaseError } from '@ogi-sdk/errors';
import { Context, Effect, Layer } from 'effect';
import { Database } from '@/electron/services/database.js';
import type { Settings as SettingsRow } from '@/lib/state.js';

/**
 * Typed read/write access to user settings. A thin facade over `Database`
 * that also owns the handful of derived readings the main process needs.
 */
export type SettingsShape = {
  readonly get: Effect.Effect<SettingsRow, DatabaseError>;
  readonly update: (
    patch: Partial<SettingsRow>
  ) => Effect.Effect<SettingsRow, DatabaseError>;
  /** Addon links the user has configured. */
  readonly addons: Effect.Effect<string[], DatabaseError>;
  readonly setAddons: (addons: string[]) => Effect.Effect<void, DatabaseError>;
  /** Trimmed Steam compatibility tool; the stored default is `proton_experimental`. */
  readonly steamCompatibilityTool: Effect.Effect<string, DatabaseError>;
};

export class Settings extends Context.Tag('Settings')<
  Settings,
  SettingsShape
>() {}

export const SettingsLive: Layer.Layer<Settings, never, Database> =
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const database = yield* Database;
      return {
        get: database.settings.get,
        update: database.settings.update,
        addons: database.settings.get.pipe(
          Effect.map((settings) => settings.addons)
        ),
        setAddons: (addons) =>
          database.settings.update({ addons }).pipe(Effect.asVoid),
        steamCompatibilityTool: database.settings.get.pipe(
          Effect.map((settings) => settings.steamCompatibilityTool.trim())
        ),
      };
    })
  );
