import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddonServer } from '@ogi-sdk/addon-server';
import {
  EventsHandlers,
  fromWs,
  LaunchHandlers,
  LaunchLive,
  LibraryHandlers,
  OGIServer,
  PromptsHandlers,
} from '@ogi-sdk/core';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Exit, Layer, Scope } from 'effect';
import { __dirname as dataDirectory } from '@/electron/manager/manager.paths.js';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import { port } from '@/electron/server/addon-server.js';
import {
  GameRunnerFromLibrary,
  LaunchHooksFromAddonServer,
} from '@/electron/server/launch-adapters.js';
import { Library } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Where local clients (Deck UI, CLI) find the port and token. */
export const CLIENT_FILE = 'client.json';
export const CLIENT_PATH = '/client';

let scope: Scope.CloseableScope | undefined;

/**
 * Mounts the client protocol on the addon server's port. A fresh token is
 * written to `client.json` (owner-only) on each start; any process that can
 * read the user's data directory can connect, nothing else can.
 */
export const startClientServer = (addonServer: AddonServer): Promise<void> =>
  runElectronEffect(
    Effect.gen(function* () {
      const token = randomBytes(32).toString('hex');
      const serverScope = yield* Scope.make();
      // The launcher lives with the server: its post-hook watcher stops when
      // the protocol does.
      const launcher = yield* Layer.buildWithScope(
        LaunchLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Library, yield* Library),
              LaunchHooksFromAddonServer,
              GameRunnerFromLibrary
            )
          )
        ),
        serverScope
      );
      const server = yield* OGIServer.make({
        token,
        implementations: [
          LibraryHandlers,
          LaunchHandlers,
          EventsHandlers,
          PromptsHandlers,
        ],
      }).pipe(Effect.provide(launcher), Scope.extend(serverScope));
      addonServer.routeUpgrade(CLIENT_PATH, (ws) => server.serve(fromWs(ws)));
      writeFileSync(
        join(dataDirectory, CLIENT_FILE),
        JSON.stringify({ url: `ws://127.0.0.1:${port}${CLIENT_PATH}`, token }),
        { mode: 0o600 }
      );
      scope = serverScope;
      logger.sync.info(`[client] protocol served at ${CLIENT_PATH}`);
    })
  );

export const stopClientServer = (): void => {
  rmSync(join(dataDirectory, CLIENT_FILE), { force: true });
  if (!scope) return;
  forkElectronEffect(Scope.close(scope, Exit.void));
  scope = undefined;
};
