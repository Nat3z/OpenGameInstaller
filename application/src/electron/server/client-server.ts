import { randomBytes } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AddonsHandlers,
  DownloadsHandlers,
  EventsHandlers,
  fromWs,
  Launcher,
  LaunchHandlers,
  LaunchLive,
  LibraryHandlers,
  OGIServer,
  type Pipeline,
  PipelineHandlers,
  PipelineLive,
  PromptsHandlers,
  type ServerSocket,
} from '@ogi-sdk/core';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Context, type Duration, Effect, Exit, Layer, Scope } from 'effect';
import { WebSocketServer } from 'ws';
import { __dirname as dataDirectory } from '@/electron/manager/manager.paths.js';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import { port, routeUpgrade } from '@/electron/server/addon-server.js';
import { AddonsFromAddonServer } from '@/electron/server/addons-adapter.js';
import {
  AddonCallsFromDevServer,
  AddonsFromDevServer,
  closeDevAddons,
  connectDevAddons,
  LaunchHooksFromDevServer,
} from '@/electron/server/dev-addons.js';
import { DownloadControlFromEngines } from '@/electron/server/downloads-bridge.js';
import {
  GameRunnerFromLibrary,
  LaunchHooksFromAddonServer,
} from '@/electron/server/launch-adapters.js';
import { DebridFromSettings } from '@/electron/server/pipeline/debrid.js';
import { EnginesFromHandlers } from '@/electron/server/pipeline/engines.js';
import {
  AddonCallsFromAddonServer,
  DownloadStoreFromDatabase,
  InstallerFromLibrary,
  PipelineConfigFromSettings,
  SleepLockFromPowerSave,
} from '@/electron/server/pipeline/host.js';
import { SetupFilesFromHandlers } from '@/electron/server/pipeline/setup-files.js';
import { Downloads, Events, Library } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Where local clients (Deck UI, CLI) find the port and token. */
export const CLIENT_FILE = 'client.json';
export const CLIENT_PATH = '/client';

let scope: Scope.CloseableScope | undefined;
let connection: { url: string; token: string } | undefined;

/** Where the desktop renderer connects; undefined until the server is up. */
export const clientConnection = ():
  | { url: string; token: string }
  | undefined => connection;

type Serve = (socket: ServerSocket) => void;

/** Listens on its own loopback port, for when the app has no addon server. */
const listenStandalone = (
  serve: Serve,
  serverScope: Scope.Scope
): Effect.Effect<number, Error> =>
  Effect.async<WebSocketServer, Error>((resume) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: CLIENT_PATH,
    });
    // A failed listen (no free descriptors, say) fails startup instead of
    // throwing as an unhandled `error` event.
    const onError = (error: Error) => {
      wss.close();
      resume(Effect.fail(error));
    };
    wss.once('error', onError);
    wss.once('listening', () => {
      wss.off('error', onError);
      resume(Effect.succeed(wss));
    });
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
 * Process-lifetime services the server only borrows. A new server (macOS
 * reopening its window) must not reset them: the launcher remembers which
 * running games are managed, and the pipeline owns every running download.
 */
const services = Effect.runSync(Scope.make());
let launcher: Context.Context<Launcher> | undefined;
let pipeline: Context.Context<Pipeline> | undefined;

/**
 * Mounts the client protocol on the addon server's port, or, when another
 * process owns that server (`ogi dev` passes `--no-server`), on a loopback
 * port of its own with addons reached over that server's SDK socket. A fresh
 * token is written to `client.json` (owner-only) on each start; any process
 * that can read the user's data directory can connect, nothing else can.
 */
export const startClientServer = (
  mode: 'addon-server' | 'standalone'
): Promise<void> =>
  runElectronEffect(
    Effect.gen(function* () {
      // A second start (macOS reopening its window) replaces the first, so
      // its watchers don't run twice.
      if (scope) yield* Scope.close(scope, Exit.void);
      scope = undefined;
      const local = mode === 'addon-server';
      const token = randomBytes(32).toString('hex');
      const serverScope = yield* Scope.make();
      // Owned from the start, so a failure below still leaves it closable.
      scope = serverScope;
      launcher ??= yield* Layer.buildWithScope(
        LaunchLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Library, yield* Library),
              local ? LaunchHooksFromAddonServer : LaunchHooksFromDevServer,
              GameRunnerFromLibrary
            )
          )
        ),
        services
      );
      // The pipeline too: rebuilding it would interrupt every running
      // download and restore them all again.
      pipeline ??= yield* Layer.buildWithScope(
        PipelineLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Library, yield* Library),
              Layer.succeed(Downloads, yield* Downloads),
              Layer.succeed(Events, yield* Events),
              EnginesFromHandlers,
              DebridFromSettings,
              PipelineConfigFromSettings,
              SetupFilesFromHandlers,
              local ? AddonCallsFromAddonServer : AddonCallsFromDevServer,
              InstallerFromLibrary,
              DownloadStoreFromDatabase,
              SleepLockFromPowerSave
            )
          )
        ),
        services
      );
      const server = yield* OGIServer.make({
        token,
        implementations: [
          LibraryHandlers,
          LaunchHandlers,
          EventsHandlers,
          PromptsHandlers,
          DownloadsHandlers,
          PipelineHandlers,
          AddonsHandlers,
        ],
      }).pipe(
        Effect.provide(launcher),
        Effect.provide(pipeline),
        Effect.provide(local ? AddonsFromAddonServer : AddonsFromDevServer),
        Effect.provide(DownloadControlFromEngines),
        Scope.extend(serverScope)
      );
      const serve: Serve = (socket) => server.serve(socket);
      if (local) routeUpgrade(CLIENT_PATH, (ws) => serve(fromWs(ws)));
      const clientPort: number = local
        ? port
        : yield* listenStandalone(serve, serverScope);
      // Before the window loads, so core is the SDK client prompts go to.
      if (!local) yield* connectDevAddons();
      const url = `ws://127.0.0.1:${clientPort}${CLIENT_PATH}`;
      const file = join(dataDirectory, CLIENT_FILE);
      writeFileSync(file, JSON.stringify({ url, token }), { mode: 0o600 });
      // `mode` only applies on create; tighten a file left by an older run.
      chmodSync(file, 0o600);
      connection = { url, token };
      logger.sync.info(`[client] protocol served at ${url}`);
    }).pipe(
      // Half-started (e.g. client.json unwritable): close what was built.
      Effect.tapErrorCause(() =>
        Effect.suspend(() => {
          const open = scope;
          scope = undefined;
          return open ? Scope.close(open, Exit.void) : Effect.void;
        })
      )
    )
  );

/** For a quit: lets core-launched games' post hooks (a save backup) finish, bounded. */
export const awaitManagedPostHooks = (
  timeout: Duration.DurationInput
): Effect.Effect<void> =>
  Effect.suspend(() =>
    launcher ? Context.get(launcher, Launcher).idle : Effect.void
  ).pipe(Effect.timeout(timeout), Effect.ignore);

export const stopClientServer = (): void => {
  rmSync(join(dataDirectory, CLIENT_FILE), { force: true });
  connection = undefined;
  closeDevAddons();
  if (!scope) return;
  forkElectronEffect(Scope.close(scope, Exit.void));
  scope = undefined;
};
