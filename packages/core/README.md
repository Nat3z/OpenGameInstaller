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

### Next: pipeline

What's left in the renderer is the orchestration: picking a source (direct,
torrent, RD/AD/Torbox/Premiumize), creating the card, and running setup when a
download completes. Moving it implements `downloads.enqueue` / `retrySetup`:

- `frontend/lib/downloads/services/*` → core `DownloadSource` adapters (one per
  service). Debrid clients already live in `packages/real-debrid` and
  `packages/all-debrid`; Torbox/Premiumize need small HTTP clients.
- `DownloadManager.svelte` completion handler + `frontend/lib/setup/*` →
  `core/setup/pipeline.ts` (extract → addon `setup` → `Library.save` → Steam)
- `frontend/lib/downloads/{persistence,restart}.ts` +
  `frontend/lib/recovery/failedSetups.ts` → core, persisted through a
  `DownloadStore` adapter (the app already has `database.downloads`)
- `frontend/lib/downloads/sleep-lock.ts` → `SleepLock` adapter

Then delete `DownloadStatusAndInfo` bookkeeping from the renderer and have it
render `downloads.watch`.

### addons

Core starts proxying addon calls (`addons.*`) through the in-process addon
server, so a frontend needs one socket. Move `executor` usage and
`checkForAddonUpdates` here.

### headless

`application/` gains `--headless`: no window, same host. A bun host
(`hosts/bun/`) becomes possible once the sqlite adapter has a `bun:sqlite`
version.

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
| `handlers/handler.{ddl,torrent}.ts`   | `core/downloads/sources/`        | downloads  |
| `handlers/handler.{realdebrid,alldebrid}.ts` | `core/downloads/sources/` | downloads |
| `manager/manager.{queue,webtorrent}.ts` | `core/downloads/`              | downloads  |
| `lib/{download-paths,torrent-files,torrent-hash}.ts` | `core/downloads/` | downloads |
| `handlers/handler.{setup,redists}.ts` | `core/setup/`                    | downloads  |
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
