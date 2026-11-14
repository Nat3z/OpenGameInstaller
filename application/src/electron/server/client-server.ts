import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddonServer } from '@ogi-sdk/addon-server';
import {
  AddonsHandlers,
  DownloadsHandlers,
  EventsHandlers,
  fromWs,
  LaunchHandlers,
  LaunchLive,
  LibraryHandlers,
  OGIServer,
  PromptsHandlers,
  type ServerSocket,
} from '@ogi-sdk/core';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Exit, Layer, Scope } from 'effect';
import { WebSocketServer } from 'ws';
import { __dirname as dataDirectory } from '@/electron/manager/manager.paths.js';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import { port } from '@/electron/server/addon-server.js';
import { AddonsFromAddonServer } from '@/electron/server/addons-adapter.js';
import {
  AddonsFromDevServer,
  closeDevAddons,
  LaunchHooksFromDevServer,
} from '@/electron/server/dev-addons.js';
import { DownloadControlFromEngines } from '@/electron/server/downloads-bridge.js';
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

type Serve = (socket: ServerSocket) => void;

/** Listens on its own loopback port, for when the app has no addon server. */
const listenStandalone = (
  serve: Serve,
  serverScope: Scope.Scope
): Effect.Effect<number> =>
  Effect.async<WebSocketServer>((resume) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: CLIENT_PATH,
    });
    wss.once('listening', () => resume(Effect.succeed(wss)));
  }).pipe(
    Effect.tap((wss) => {
      wss.on('connection', (ws) => serve(fromWs(ws)));
      return Scope.addFinalizer(
        serverScope,
        Effect.sync(() => wss.close())
      );
    }),
    Effect.map((wss) => (wss.address() as { port: number }).port)
  );

/**
 * Mounts the client protocol on the addon server's port, or, when another
 * process owns that server (`ogi dev` passes `--no-server`), on a loopback
 * port of its own with addons reached over that server's SDK socket. A fresh
 * token is written to `client.json` (owner-only) on each start; any process
 * that can read the user's data directory can connect, nothing else can.
 */
export const startClientServer = (addonServer?: AddonServer): Promise<void> =>
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
              addonServer
                ? LaunchHooksFromAddonServer
                : LaunchHooksFromDevServer,
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
          DownloadsHandlers,
          AddonsHandlers,
        ],
      }).pipe(
        Effect.provide(launcher),
        Effect.provide(
          addonServer ? AddonsFromAddonServer : AddonsFromDevServer
        ),
        Effect.provide(DownloadControlFromEngines),
        Scope.extend(serverScope)
      );
      const serve: Serve = (socket) => server.serve(socket);
      addonServer?.routeUpgrade(CLIENT_PATH, (ws) => serve(fromWs(ws)));
      const clientPort: number = addonServer
        ? port
        : yield* listenStandalone(serve, serverScope);
      const url = `ws://127.0.0.1:${clientPort}${CLIENT_PATH}`;
      writeFileSync(
        join(dataDirectory, CLIENT_FILE),
        JSON.stringify({ url, token }),
        { mode: 0o600 }
      );
      scope = serverScope;
      logger.sync.info(`[client] protocol served at ${url}`);
    })
  );

export const stopClientServer = (): void => {
  rmSync(join(dataDirectory, CLIENT_FILE), { force: true });
  closeDevAddons();
  if (!scope) return;
  forkElectronEffect(Scope.close(scope, Exit.void));
  scope = undefined;
};
