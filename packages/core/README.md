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

### Next: events

Move every remaining `webContents.send` / `sendIPCMessage` onto `Events` (or
the owning group's `watch` when it is state, not a notice). There are about 30
send sites; grep `sendIPCMessage\(|webContents.send\(` in
`application/src/electron`. The renderer keeps its IPC listener by having the
host forward `Events` to IPC, so no Svelte changes are needed yet.

### prompts

Add a `Prompts` service: `open(prompt) -> Effect<Answer>` backed by a
`Deferred` per prompt and a change feed for `prompts.watch`. First answer wins.
Then move these onto it:

- `confirmSteamClose` in `handlers/handler.steam.ts` (`dialog.showMessageBox`)
- `sendAskForInput` + `screenInputCallbacks` in `main.ts` (addon `input-asked`)
- `RootPasswordGranter.svelte` (redistributables)

### launch

Move `launchGameFromLibrary`, the umu launch path, and the pre/post hook flow
from `GameLaunchOverlay.svelte` into `lib/launch/`. Implement `library.launch`.
After this, a Steam `--game-id` launch needs no window.

### downloads

The largest pass. It moves the renderer's orchestration into core:

- `frontend/lib/downloads/services/*` -> `DownloadSource` adapters
- `frontend/lib/downloads/{lifecycle,persistence,restart,pause-resume}.ts`
  -> `lib/downloads/queue.ts` + persistence through a `DownloadStore` adapter
- `frontend/lib/setup/*` + `DownloadManager.svelte` completion handler
  -> `lib/setup/pipeline.ts`
- `frontend/lib/recovery/failedSetups.ts` -> `downloads.retrySetup`
- `frontend/lib/downloads/sleep-lock.ts` -> `SleepLock` adapter
- `electron/handlers/handler.{ddl,torrent,realdebrid,alldebrid}.ts`

Then implement every method in the `downloads` group.

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
| `main.ts` `sendIPCMessage` sites      | core `Events`                    | events     |
| `handlers/handler.steam.ts`           | `core/steam/`                    | prompts    |
| `lib/steam-{vdf,shortcuts,installation,process,grid-db}.ts` | `core/steam/` | launch |
| `handlers/handler.library.ts`         | `core/library/`, `core/launch/`  | launch     |
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
