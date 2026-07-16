import type { AddonConnection } from '@ogi-sdk/addon-server';
import { AddonFileConfigurationSchema, Addon as ExecutorAddon } from '@ogi-sdk/executor';
import { AddonError, AddonLoadError, FileSystemError, formatError } from '@ogi/errors';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import { sendNotification } from '@/electron/main.js';
import { addonServer, port } from '@/electron/server/addon-server.js';

export class Addon extends ExecutorAddon {
  static readonly running = new Map<string, Addon>();

  private static stripAnsi(input: string): string {
    return input.replace(new RegExp('\\x1b\\[[0-9;]*m', 'g'), '');
  }

  static loadEffect(addonPath: string): Effect.Effect<Addon, AddonLoadError> {
    const addonName = addonPath.replace(/\/$/, '').split(/[/\\]/).pop() ?? 'unknown-addon';
    return Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(join(addonPath, 'addon.json'), 'utf-8'),
        catch: (cause) => new AddonLoadError({ addonName, cause }),
      });
      const json = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new AddonLoadError({ addonName, cause }),
      });
      const parsed = yield* Schema.decodeUnknown(AddonFileConfigurationSchema)(json).pipe(
        Effect.mapError((cause) => new AddonLoadError({ addonName, cause }))
      );
      const secret = yield* addonServer.getSecret().pipe(
        Effect.mapError((cause) => new AddonLoadError({ addonName, cause }))
      );
      return new Addon({ port, secret, path: addonPath, name: addonName, scripts: parsed.scripts });
    }).pipe(Effect.tapError((error) => Effect.sync(() => {
      sendNotification({ type: 'error', message: `Failed to load addon ${addonName}: ${formatError(error.cause)}`, id: Math.random().toString(36).substring(7) });
    })));
  }

  static load(addonPath: string): Promise<Addon | null> {
    return Effect.runPromise(Addon.loadEffect(addonPath).pipe(Effect.catchAll(() => Effect.succeed(null))));
  }

  override stop(): Effect.Effect<void, AddonError> {
    return super.stop().pipe(Effect.tap(() => Effect.sync(() => Addon.running.delete(this.config.path))));
  }

  installEffect(): Effect.Effect<boolean> {
    return Effect.gen(this, function* () {
      sendNotification({ type: 'info', message: `Setting up ${this.config.name}`, id: Math.random().toString(36).substring(7) });
      const setupLogs = yield* this.setup.collectSetupLog();
      yield* Effect.tryPromise({
        try: () => writeFile(join(this.config.path, 'installation.log'), Addon.stripAnsi(setupLogs)),
        catch: (cause) => new FileSystemError({ message: formatError(cause), path: this.config.path, cause }),
      });
      return true;
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
      console.error(error);
      sendNotification({ type: 'error', message: `Error running setup scripts for ${this.config.name}`, id: Math.random().toString(36).substring(7) });
      return false;
    })));
  }

  install(): Promise<boolean> {
    return Effect.runPromise(this.installEffect());
  }

  startRegisteredEffect(addonLink: string): Effect.Effect<AddonConnection | undefined> {
    return Effect.gen(this, function* () {
      yield* this.start();
      if (!this.getChildProcess()) return undefined;
      Addon.running.set(this.config.path, this);
      let attempts = 0;
      while (!addonServer.getClient(this.config.name) && attempts <= 10) {
        attempts += 1;
        yield* Effect.sleep('500 millis');
      }
      const client = addonServer.getClient(this.config.name);
      if (!client) return undefined;
      client.filePath = this.config.path;
      client.addonLink = addonLink;
      return client;
    }).pipe(Effect.catchAll((error) =>
      Effect.gen(this, function* () {
        yield* Effect.tryPromise({
          try: () => writeFile(join(this.config.path, 'run-crash.log'), Addon.stripAnsi(formatError(error))),
          catch: (cause) => new FileSystemError({ message: formatError(cause), path: this.config.path, cause }),
        }).pipe(Effect.ignore);
        sendNotification({ type: 'error', message: `Error running addon ${this.config.name}`, id: Math.random().toString(36).substring(7) });
        return undefined;
      })
    ));
  }

  startRegistered(addonLink: string): Promise<AddonConnection | undefined> {
    return Effect.runPromise(this.startRegisteredEffect(addonLink));
  }
}
