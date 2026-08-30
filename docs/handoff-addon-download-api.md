# Handoff: `addon.download()` — addon-enqueued downloads via the app's download queue

## Task

Add an API to the OGI addon SDK so addons can enqueue raw file downloads into the app's global download queue and track them with a promise/abort/wait handle. Spec was fully grilled and confirmed by shar; do not re-litigate decisions below.

## Confirmed spec

**SDK API** (new on `OGIAddon` in `packages/ogi-addon/src/main.ts`):

```ts
const dl = await addon.download({
  name: string,
  files: [{ link: string, path: string, headers?: Record<string, string> }],
  appID?: number,        // infers card metadata from library/store data
  capsuleImage?: string, // explicit fields win over appID inference
});
dl.id; dl.queuePosition;          // queuePosition live-updated
dl.on('progress', ({ progress, downloadSpeed, queuePosition }) => {});
dl.on('status', ...);             // paused / resumed / etc.
await dl.wait();                  // resolves on complete; rejects on fail/abort/user-cancel
dl.abort();
```

**Decisions (final):**

1. **Raw file primitive** — no setup phase, no library entry. Direct HTTP(S) only for v1 (no torrent/magnet/debrid; `downloadType` can be added later).
2. **Same global `DOWNLOAD_QUEUE`** as user downloads — one-at-a-time invariant, shared bandwidth token bucket, parallel-chunk limits, real queue positions.
3. **Shows in the download manager UI** as a normal card. Main process must push card creation to the renderer (new plumbing — today cards are created renderer-side in e.g. `DirectService`). Metadata resolution: explicit fields → appID lookup → name + generic fallback (card component may need a no-imagery fallback path).
4. **Paths**: absolute allowed; relative resolves under the user's download dir (sanitized like `safeDownloadPath`). Addons are trusted local processes; no sandbox theater.
5. **Full user control from UI** — pause/resume/cancel all work on addon cards. Addon gets status events; user-cancel rejects `wait()` identically to `dl.abort()`.
6. **Addon disconnect aborts its queued/in-flight downloads.** Partial files stay on disk (engine already resumes partials if re-enqueued).
7. **Progress pushed to the addon** over the socket, throttled (~100ms cadence like `defer-update`'s reporter).

## Codebase map (verified)

- **Queue**: `application/src/electron/manager/manager.queue.ts` — `DOWNLOAD_QUEUE.enqueue(id, item)` returns `{ initialPosition, wait, cancelHandler, finish }`. Don't leak this shape to addons; `finish`/`cancelHandler` are internal.
- **Download engine**: `application/src/electron/handlers/handler.ddl.ts` — `Download` class; `start()` enqueues into `DOWNLOAD_QUEUE`, registers cancel via `registerQueueCancel` (`application/src/electron/rpc/queue-cancel.ts`), reports via handshake. Reuse this class rather than duplicating.
- **Handshake/lifecycle**: `application/src/lib/download-handshake.ts` — enqueue-ack pattern (`waitForDownloadHandshake`) plus terminal-event replay. `addon.download()`'s initial resolve mirrors this.
- **Protocol registry (single source of truth)**: `packages/connection/lib/protocol.ts` — add new `addonToServer` rows (e.g. `download-request`, plus whatever the ack/progress/terminal flow needs; study `task-update` + `defer-update` and `get-app-details` request/response for the two existing patterns). Wire envelopes/unions derive automatically from the registry.
- **Server handlers**: `packages/addon-server/lib/handlers/client-message-handlers.ts` — add handler(s); follow `handleTaskUpdate`/`handleGetAppDetails` style. The addon-server package is transport; the electron app (`application/src/electron/server/addon-server.ts` instantiates `AddonServer`) is where the bridge to `DOWNLOAD_QUEUE`/`Download` lives — likely a server event the electron layer subscribes to, like `notification`/`input-asked` do.
- **SDK handle**: `packages/ogi-addon/src/main.ts` — follow the existing `Task` class pattern (WebSocket-mode: id + `schedule(effect)` runner; Effect internals, promise-compatibility adapters public). The SDK is Effect-based (`@ogi-sdk` packages, effect-ts) — match that style.
- **Disconnect cleanup**: server side tracks addon-owned download ids per connection; on client disconnect, abort them (queue-cancel path already unifies queued vs in-flight cancel).

## Proof

Add a small `addon.download()` usage to `test-addon` (e.g. behind a task/config action downloading a small file) to verify socket → server → queue → UI card → progress events → `wait()` end to end. No test suite beyond anything that falls out naturally (shar's preference — minimal, focused tests only).

## Style notes

- Concise, layered abstractions; no function sprawl. Explicit typing. Effect-ts primitives in SDK/server code. Conventional-commit format, concise (e.g. `feat(ogi-addon): addon-enqueued downloads`). Comments sparse but kept in sync — update any queue/protocol comments touched. PRs via the `make-pr` skill.
