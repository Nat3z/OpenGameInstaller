# @ogi-sdk/core

The OpenGameInstaller engine. Core serves `@ogi-sdk/protocol` to any client
and, over a series of passes, takes over everything that installs and runs
games: the library, download queue, setup pipeline, launch hooks, Steam and
umu. A **host** (today the Electron app) supplies the few adapters that depend
on where OGI runs, then mounts core on a socket.

```
@ogi-sdk/protocol   the contract (schemas, envelope)
@ogi-sdk/core       the engine   (server + services + pipeline)   <- this package
application/        a host       (paths, sqlite driver, window, lifecycle)
@ogi-sdk/client-kit a frontend's handle on all of it
```

## The boundary rule

> If it would be the same no matter which app hosts OGI, it lives in core.
> If it depends on the shell or runtime, the host provides it.

Core may use `node:fs`, `node:child_process`, and so on directly. It does not
wrap the filesystem in its own storage abstraction, because game files must be
on a local disk to run. Adapters exist only where there really is more than
one implementation:

| Adapter (Context tag)    | Why it's swappable                         | Status            |
| ------------------------ | ------------------------------------------ | ----------------- |
| `LibraryStore`           | better-sqlite3 (Electron) vs bun:sqlite    | done              |
| `DownloadSource`         | direct, torrent, RD, AD, Torbox, Premiumize | todo (downloads)  |
| `TorrentClient`          | webtorrent vs qBittorrent                   | todo (downloads)  |
| `SleepLock`              | powerSaveBlocker vs systemd-inhibit         | todo (downloads)  |
| `Shell` (optional)       | native pickers / window show-hide           | todo (launch)     |

Use `@effect/platform`'s `FileSystem` and `CommandExecutor` for OS work in new
code, rather than mixing `fs`, `fs/promises`, and `original-fs`.

## What's in it now

```
lib/
  server/server.ts      OGIServer: handshake, routing, one fiber per call/sub
  server/router.ts      implement(group, handlers); missing methods -> MethodNotFound
  server/socket.ts      ServerSocket + fromWs() adapter
  library/library.ts    Library service + LibraryStore adapter + change feed
  library/handlers.ts   serves library.list / get / watch
  library/manifest.ts   .ogi-game.json mirror (moved from application)
  library/delete-guards.ts  path safety for deletes (moved from application)
  events/events.ts      Events service; serves events.watch
```

### Hosting core

```ts
const server = yield* OGIServer.make({
  token,
  implementations: [LibraryHandlers, EventsHandlers],
}); // requires Library | Events, inferred from the implementations

addonServer.routeUpgrade('/client', (ws) => server.serve(fromWs(ws)));
```

The Electron host does this in `application/src/electron/server/client-server.ts`
and provides `Library` with `LibraryLive` + `LibraryStoreFromDatabase`.

### Writing a handler

```ts
export const LibraryHandlers = implement<typeof LibraryGroup, Library>(
  LibraryGroup,
  {
    list: () => Effect.flatMap(Library, (library) => library.list),
    // A stream returns its snapshot and its updates separately. Subscribe to
    // the change feed BEFORE reading the snapshot so nothing falls between.
    watch: () => Effect.flatMap(Library, (library) => library.watch),
  }
);
```

## Passes

Each pass moves one slice out of `application/` and ships on its own. The
desktop app must behave the same after every pass.

### Done: protocol + library slice

- `OGIServer`, router, socket adapter, contract test (`server.test.ts`)
- `Library` service moved here; the app keeps only `LibraryStoreFromDatabase`
- manifests and delete guards moved here with their tests
- `Events` service; `sendNotification` publishes to it
- game launch/exit published as `library.watch` updates

### Done: events

Notices go through core `Events`; nothing outside the bridge talks to a window.

- `publishEvent(...)` in `application/src/electron/server/events-bridge.ts` is
  the only way to emit: notifications, addon started/updated/manifests,
  launch requested/failed, migrations, changelog, OOBE log
- game launch/exit are `Library.notifyLaunched/Exited`, delivered on
  `library.watch`
- `forwardEventsToRenderer` maps each event back to its old IPC channel, so the
  Svelte app is unchanged. It is deleted once the renderer subscribes over the
  protocol.
- `checkForAddonUpdates` and `AddonManagerHandler` no longer take `mainWindow`

Still on IPC, on purpose. These are **state**, so each moves with the pass that
owns it, onto that group's `watch`, not onto `Events`:

| Channel                                   | Moves with | Becomes                 |
| ----------------------------------------- | ---------- | ----------------------- |
| `ddl:*`, `torrent:*`, `addon-downloads`   | downloads  | `downloads.watch`       |
| `setup:log`, `processing:progress`        | downloads  | `downloads.logs/watch`  |
| `app:redistributable-progress`            | downloads  | `downloads.watch`       |
| `game:removal-progress`                   | launch     | `library.watch`         |
| `input-asked`                             | prompts    | `prompts.watch`         |
| `splash-*`                                | stays      | host-only (splash UI)   |

### Done: prompts

`Prompts.ask(request)` waits for a human; every client sees it and the first
`prompts.reply` wins. An interrupted ask closes the prompt for everyone.

- Steam close confirmation (`confirmSteamClose`) asks a `Confirm` prompt, so
  `runSteamMutationWithConfirmation`, `addUmuGameToSteam`,
  `addDeckGameToSteam`, `launchGameFromLibrary`, and the steam/library/redist
  routers no longer take `mainWindow`
- addon `input-asked` goes through `AddonServer({ askInput })` to an `Input`
  prompt; `sendAskForInput`, `currentScreens`, and `screenInputCallbacks` are gone
- `showPromptsInWindow` (`application/.../server/prompts-bridge.ts`) shows
  prompts in the desktop UI: `Input` on the existing modal, `Confirm` as the
  same native dialog. Deleted once the renderer uses `prompts.watch`.

Not moved: the root password prompt. `app.grantRootPassword` was never
implemented (it throws), so there is no flow to port yet. When one exists, add
a `Secret` prompt.

### Done: launch

`library.launch` works from any client, with no window:

```
Launcher.launch(appID)
  pre hooks ── fail? ── Prompts: "Launch anyway?" ── no → LibraryError
  claimHooks(appID)        // this session is "managed"
  GameRunner.start(appID)  // host adapter: umu / legacy spawn
  ...game exits → Exited { managed: true } → post hooks
```

- adapters: `LaunchHooks` (run `launch-app` on every addon) and `GameRunner`
  (start the process). The Electron host's are in
  `application/src/electron/server/launch-adapters.ts`.
- `Launched`/`Exited` carry `managed`. Core runs hooks only for managed
  sessions; the renderer runs them only for the rest, so a session never gets
  hooks twice while both paths exist.
- the Launcher is built inside the client server's scope, so its post-hook
  watcher stops with the protocol.

Still in the renderer: `PlayPage` / `GameManager` / `GameLaunchOverlay` keep
their own launch + hooks for desktop launches. They switch to `library.launch`
when the renderer moves to `OGIClient`. The Steam `--game-id` flow in `main.ts`
also keeps its own hooks, because the wrapper command runs between them.

### Done: download state

Core owns what every client sees about downloads; engines no longer hold a
window.

```
engine (ddl / torrent / setup / redist / addon card)
  └─ emitDownload(channel, data)          application/.../downloads-bridge.ts
       ├─ toPatch → Downloads.report/remove/log   (core: downloads.watch, logs)
       └─ sendIPCMessage(channel, data)           (renderer, unchanged)
```

- `Downloads` merges partial reports, so each source sends only what it
  knows (engines: progress; the addon card: name/appID; setup: status).
- `downloads.pause/resume/cancel` go through the `DownloadControl` adapter,
  which finds the engine that owns the id (or the queue, if it hasn't started).
- `Download` / `TorrentDownload` constructors and the ddl/torrent routers no
  longer take `mainWindow`.

### Done: pipeline

`downloads.enqueue` runs the whole thing in core. The renderer only calls
`enqueue` and renders `downloads.watch`; there is no download, debrid, or
setup code left in it.

```
enqueue(result) ─▶ record saved (step: download)
  resolve      request → AddonCalls.requestDownload; torrent → Debrid.resolve
  download     Engines.direct / Engines.torrent; engine id aliased onto ours
  extract      SetupFiles.extract (debrid rar/zip), content root found
  setup        stage old_files (updates) → AddonCalls.setup (prompts → Prompts)
  install      Installer.install (UMU, Steam) / Installer.update
  redist       Installer.redistributables (Linux prefixes)
  ─▶ record removed, card `completed`
```

- one fiber per download (`FiberMap`), every step saved to `DownloadStore`
  before it runs. A crash mid-transfer comes back `paused` (`downloads.resume`
  restarts the engine); a crash after it resumes on its own.
- a failure once files are on disk keeps the record with an `error`: it shows
  on `downloads.failedSetups` and `downloads.retrySetup` picks it up from the
  step it failed on, without downloading again.
- `Downloads.alias(engineId, id)` makes engine progress land on the pipeline's
  card, so one download is one card while engines come and go underneath.
- the sleep lock watches `downloads.watch` itself: awake while anything is
  resolving, downloading, extracting, or setting up.

Adapters (all in `lib/pipeline/adapters.ts`; Electron's in
`application/src/electron/server/pipeline/`):

| Adapter         | Electron implementation                                  |
| --------------- | -------------------------------------------------------- |
| `Engines`       | ddl `DownloadService` + `startTorrent`, via `onTerminal` |
| `Debrid`        | Real-Debrid / AllDebrid clients, TorBox / Premiumize HTTP |
| `PipelineConfig`| settings: download root, torrent client                  |
| `SetupFiles`    | guarded fs helpers from `handler.setup.ts`               |
| `AddonCalls`    | `AddonConnection.deferred` (or the SDK under `ogi dev`)  |
| `Installer`     | `insertApp` / `updateAppVersion` / redistributables      |
| `DownloadStore` | the existing `downloads` table (`download_info.pipeline`) |
| `SleepLock`     | Electron `powerSaveBlocker`                              |

### Done: `ogi dev`

`ogi dev` (ogi-kit) hosts the addon server itself and launches the app with
`--no-server`. The app then serves `/client` on its own loopback port
(`client.json` has the url) and core reaches addons as an SDK client of the
CLI's server: `AddonsFromDevServer` and `LaunchHooksFromDevServer` in
`application/src/electron/server/dev-addons.ts`. Addon `input-asked` from
that server goes to core `Prompts` too, so any client can answer.

### Next: the rest of the renderer

Launch (`PlayPage`, `GameManager`) and the IPC bridges for events and prompts
still exist; launch can move to `library.launch` the same way downloads moved.

### Later: a bun host

A host without Electron needs a `bun:sqlite` `LibraryStore` and replacements for
the few Electron APIs still used in startup (`app.getAppPath`, dialogs). Core
itself is already runtime-agnostic.

## Migration map

Where each file in `application/src/electron` ends up. "host" means it stays
in `application/` as an adapter or Electron glue.

| File / folder                         | Goes to                          | Pass       |
| ------------------------------------- | -------------------------------- | ---------- |
| `lib/library-manifest.ts`             | `core/library/manifest.ts`       | done       |
| `lib/delete-guards.ts`                | `core/library/delete-guards.ts`  | done       |
| `services/library.ts`                 | core `Library` (host: store)     | done       |
| `main.ts` `sendIPCMessage` sites      | core `Events`                    | done       |
| `handlers/handler.steam.ts`           | `core/steam/`                    | prompts    |
| `lib/steam-{vdf,shortcuts,installation,process,grid-db}.ts` | `core/steam/` | launch |
| `handlers/handler.library.ts` launch  | core `Launcher` + host `GameRunner` | done    |
| `handlers/handler.library.ts` rest    | `core/library/`                  | library    |
| `handlers/handler.umu.ts`, `lib/umu-prefix-migration.ts` | `core/launch/umu/` | launch |
| `lib/{launch-command,spawn-shell,gamescope}.ts` | `core/launch/`         | launch     |
| `frontend/lib/downloads/*`, `lib/setup/*`, `lib/recovery/*`, `DownloadManager` | `core/pipeline/` | done |
| `handlers/handler.{ddl,torrent}.ts`   | host `Engines` (engines stay)    | done       |
| debrid (renderer services + `handler.{realdebrid,alldebrid}.ts`) | host `Debrid` | done |
| `handlers/handler.{setup,redists}.ts` | host `SetupFiles` / `Installer`  | done       |
| `manager/manager.{queue,webtorrent}.ts` | host (engine internals)        | stays      |
| `server/addon-{server,downloads,lifecycle}.ts` | `core/addons/`          | addons     |
| `manager/manager.addon*.ts`, `lib/addon-links.ts`, `lib/marketplace*.ts` | `core/addons/` | addons |
| `startup.ts` (`checkForAddonUpdates`, `reinstallAddonDependencies`) | `core/addons/` | addons |
| `database/`                           | `core/storage/` (host passes driver) | headless |
| `migrations.ts`                       | `core/storage/`                  | headless   |
| `handlers/handler.{state,setup}.ts` settings bits | core `Settings`      | headless   |
| `main.ts`, `startup-runner.ts`, `preload*.mts`, `rpc/`, `updater.ts`, `system-updater.ts` | host | stays |
| `handlers/handler.{fs,app,oobe,power-save}.ts` | host (`Shell`, `SleepLock`) | stays |

## Development

```sh
bun run build
bun run typecheck
bun test          # includes the client <-> server contract test
```
