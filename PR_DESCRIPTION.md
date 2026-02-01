# Pull Request: Startup flow refactor & single-window splash (Steam Deck)

## Summary

This PR refactors the Electron startup flow so that a **single BrowserWindow** can show the splash screen first, then the main app—fixing Steam Deck / Game Mode behavior where a separate splash window caused focus issues (e.g. black screen). Startup logic is moved into a dedicated **startup-runner** module, and the main preload script is updated to forward splash IPC when the main window is displaying the splash page.

**Files changed:**
- `application/src/electron/startup-runner.ts` — Startup orchestration and splash UI targeting
- `application/src/electron/preload.mts` — Splash IPC forwarding and client-ready signal for single-window flow

---

## Key modifications

### 1. `startup-runner.ts`
- **Single-window splash:** `runStartupTasks(mainWindow?)` accepts an optional main window. When provided, splash status/progress is sent to that window only; no separate splash window is created. When omitted, a legacy separate splash window is created.
- **Centralized startup sequence:** Runs in order: restore backup → execute migrations → remove cached app updates → reinstall addon dependencies (if backup flag set) → check for installer updates. All steps use `updateSplashStatus` / `updateSplashProgress` for user feedback.
- **Splash targeting:** `splashTargetWindow` and `splashWindow` are used so both single-window and legacy flows get status/progress; helpers `updateSplashStatus()` and `updateSplashProgress()` send to whichever target is active.
- **Exports:** `closeSplashWindow()` and `runStartupTasks(mainWindow?)` for use from `main.ts`.

### 2. `preload.mts`
- **Splash IPC forwarding:** New listeners for `splash-status` and `splash-progress` so that when the main window is showing `splash.html` (single-window flow), it receives IPC and dispatches matching `CustomEvent`s for the splash page to consume.
- **Client-ready signal:** Preload sends `client-ready-for-events` at load so the main process can gate IPC until the renderer is ready.
- **Debug instrumentation (if present):** Optional wrap/counter and `dbg:events-proc` / `dbg:error` events for profiling and error handling; all exposed API and IPC listeners may be wrapped for consistency.

---

## Testing notes

- **Single-window flow (Steam Deck / default):** Start app → main window should show splash first (status/progress during backup, migrations, cleanup, addon reinstall, updater check), then load main app in the same window. No separate splash window.
- **Splash content:** Verify splash screen shows updating status text and progress bar during each startup phase.
- **Backup restore:** After an update that created a backup, startup should show “Restoring backup…” and progress; if `needs-addon-reinstall` flag existed, “Reinstalling addon dependencies…” should run.
- **Legacy path:** If `runStartupTasks()` were called without a window (e.g. in tests or alternate entry), a separate splash window should be created and receive the same status/progress.
- **Main process IPC:** After load, main process should only send IPC to the main window after `client-ready-for-events` is received (no missed or premature messages).

---

## Breaking changes & migrations

- **No breaking API changes.** `runStartupTasks(mainWindow?)` is optional-arg; existing callers that pass no argument keep the previous separate-splash-window behavior.
- **No data migrations.** Startup sequence still uses the same backup format, migration runner, and config paths; only orchestration and which window gets splash updates changed.
- **Frontend:** Any UI that assumes a separate splash window can be updated to rely on the main window showing splash first; `splash.html` already listens for `splash-status` and `splash-progress` CustomEvents, which the preload now forwards in the single-window case.
