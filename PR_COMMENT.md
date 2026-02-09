## Summary of changes (PR #51 – review feedback)

This round addresses **CodeRabbit’s** feedback about duplicate IPC handler registration and window lifecycle.

### 1. Domain IPC handlers registered only once

- **Issue:** `onMainAppReady` was re-registering domain handlers (App, FS, RealDebrid, Torrent, DDL, Addon, OOBE) on every main window load, which could cause duplicate `ipcMain.handle`/`on` behavior when the window was recreated (e.g. macOS activate).
- **Change:**
  - Introduced a module-level flag `domainHandlersRegistered` in `main.ts`. Domain handler setup runs only once (when the first main window becomes ready).
  - Exported `getMainWindow()` from `main.ts` so handlers always target the *current* main window (including after a recreate on macOS activate).
  - Updated all domain handlers to use `getMainWindow()` instead of a captured `mainWindow` argument:
    - **handler.app.ts:** `app:close` and `app:minimize` use `getMainWindow()`; `registerLibraryHandlers()` takes no argument and uses `getMainWindow()` in callbacks.
    - **library-handlers.ts:** `registerLibraryHandlers()` takes no argument; all `webContents.send` callbacks use `getMainWindow()`.
    - **handler.realdebrid.ts:** Error path uses `getMainWindow()` for `ddl:download-error`.
    - **handler.addon.ts:** `addon:updated` sends via `getMainWindow()?.webContents.send`.
    - **handler.torrent.ts:** `TorrentDownload` no longer stores a window reference; `sendIpc` uses `getMainWindow()`.
    - **handler.ddl.ts:** `Download` no longer stores a window reference; `sendIpc` uses `getMainWindow()`.

Handlers are registered once and always send to the current main window (or no-op if it is null/destroyed).

### 2. Reviewer → resolution

| Reviewer / check | Comment / finding | What was done |
|------------------|-------------------|----------------|
| **CodeRabbit — main.ts** | Domain IPC handlers re-registered each time the window loads; duplicate handle/on errors | Added `domainHandlersRegistered`; domain handler setup runs once. Handlers use `getMainWindow()` so they target the current window after recreate. |
| **CodeRabbit — main.ts** | `onMainAppReady` uses `mainWindow!!` / can crash if window closed during startup | *(Already addressed in a prior round: early return when `!mainWindow`, local `win` in devtools callback.)* |
| **CodeRabbit — main.ts** | `runPostSplashStartup` should re-check `mainWindow` after `await runStartupTasks` | *(Already addressed: second null/destroyed check and early return.)* |
| **CodeRabbit — main.ts** | On macOS activate, reset renderer-readiness flag | *(Already addressed: `isReadyForEvents = false` when recreating the window.)* |
| **CodeRabbit — startup-runner** | Splash via `file://` + join; use `loadFile` or proper file URL | *(Already addressed: splash loads with `loadFile`.)* |
| **CodeRabbit — startup-runner** | Swallowed error in `removeCachedAppUpdates` catch | *(Already addressed: catch logs the error.)* |
| **CodeRabbit — ButtonModal / danger** | Use `bg-error-bg` instead of `bg-error-border` for danger buttons | *(Already addressed in a prior round.)* |

### 3. Design / trade-offs

- **Single registration, current window:** Handlers are registered once to avoid duplicate registration. They resolve the window at send time via `getMainWindow()`, so after a window is closed and recreated (e.g. macOS activate), IPC still goes to the new window. No need to re-call handler setup when the window is recreated.
- **Nat3z — hardcoded light values / `bg-white`:** In the **application** frontend (this PR’s scope) there is no `bg-white` in the changed files. Remaining `text-white` / `text-white/70` are on hero overlays (e.g. StorePage, PlayPage) where light text on a dark gradient is intentional. Any broader pass on light-theme-only values can be done in a follow-up.
- **Sass type definition:** Resolved in #64; no change in this PR.
- **Pre-existing check failures:** `npm run check` still reports existing errors (e.g. type-only imports, RequestService types, DeferrableTask, AddonConnection) in files outside this round of edits. No new errors were introduced by these changes.

### 4. Next steps

If you want to extend this PR, we can:
- Add a follow-up pass for any remaining hardcoded light-theme colors (e.g. in web or other repos).
- Tackle the pre-existing type/check issues in a separate PR.

If anything else is needed for this round, say what you’d like and we can adjust.
