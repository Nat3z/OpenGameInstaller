# Issue #14 Implementation Plan: Single-Window Splash (Steam Deck / Game Mode)

## Issue summary

**Goal:** Fix Steam Deck / Game Mode behavior where a **separate splash window** caused focus issues (e.g. black screen). Refactor the Electron startup flow so a **single BrowserWindow** shows the splash first, then the main app—keeping focus on one window throughout.

**Source:** Branch `fix/issue-14-open` and `PR_DESCRIPTION.md` (Startup flow refactor & single-window splash).

---

## 1. Files to modify

| File | Role |
|------|------|
| `application/src/electron/main.ts` | Gate startup on client-ready; optionally fix activate flow |
| `application/src/electron/startup-runner.ts` | (Optional) Document or adjust timing; already correct |
| `application/src/electron/preload.mts` | No change if client-ready is sent when splash loads (already does) |

**Files that are already correct (no change required):**

- `application/src/electron/startup-runner.ts` — Single-window vs legacy flow, `runStartupTasks(mainWindow?)`, `splashTargetWindow` / `splashWindow`, `updateSplashStatus` / `updateSplashProgress`, full startup sequence.
- `application/src/electron/preload.mts` — Splash IPC forwarding (`splash-status`, `splash-progress` → CustomEvents), `client-ready-for-events` sent at preload end.
- `application/public/splash.html` — Listens for `splash-status` and `splash-progress` CustomEvents; updates status, subtext, progress bar, spinner.
- `application/src/electron/splash-preload.mts` — Used only by the **legacy** separate splash window; no change for single-window flow (main window uses main preload).

---

## 2. Specific changes

### 2.1 Gate `runStartupTasks` on `client-ready-for-events` (main.ts)

**Problem:** `runStartupTasks(mainWindow!)` is called immediately after `createWindow()`. The main window has only *scheduled* loading `splash.html`; the preload may not have run yet, so splash IPC could be sent before the renderer has registered `splash-status` / `splash-progress` listeners. PR requirement: *"main process should only send IPC to the main window after client-ready-for-events is received (no missed or premature messages)."*

**Change:**

1. **Wait for first `client-ready-for-events` before starting startup tasks.**  
   - In `main.ts`, do not call `runStartupTasks(mainWindow!)` until the main process has received `client-ready-for-events` from the **splash** page (the first load of the main window).
   - Implementation options:
     - **Option A:** Resolve a Promise when `ipcMain.on('client-ready-for-events', ...)` fires, and `await` that Promise before `runStartupTasks(mainWindow!)`.  
       - Caveat: the same channel is used again when the **main app** page loads (second load). So the first time we get `client-ready-for-events` it’s from the splash; the second time from the main app. Use a one-time resolver: e.g. a Promise that resolves on the **first** `client-ready-for-events` and then ignore further emissions for that purpose, or use a dedicated channel like `splash-ready-for-events` for the splash page only.
     - **Option B (recommended):** Introduce a one-time “splash ready” signal:
       - In preload: when the document’s URL or a data attribute indicates we’re on the splash page (e.g. `window.location.pathname` or a query param), send `client-ready-for-events` (or a new channel e.g. `splash-ready-for-events`) once. When on the main app page, send `client-ready-for-events` as today.
       - In main: wait for the splash-ready signal (or the first `client-ready-for-events`) before starting `runStartupTasks`. After that, keep existing behavior for main-app `client-ready-for-events` (set `isReadyForEvents = true` and wake waiters).
   - Simplest approach that matches PR: **wait for the first `client-ready-for-events`** before calling `runStartupTasks`. That first emission is from the splash (main window’s first load). When the main app loads, it will send `client-ready-for-events` again; the existing handler already sets `isReadyForEvents = true` and resolves waiters, so no change needed there. Only add: before `runStartupTasks`, await a Promise that resolves on the **first** `client-ready-for-events` (e.g. a `splashReadyPromise` that you resolve once and never again from that listener).

2. **Concrete steps in `main.ts`:**
   - Before `app.on('ready', ...)`: add a `Promise` (e.g. `splashReadyPromise`) and a resolver (e.g. `resolveSplashReady`).
   - In the existing `ipcMain.on('client-ready-for-events', ...)` (or in a separate one-time listener): on first invocation, call `resolveSplashReady()` so that the first load (splash) signals readiness.
   - In `app.on('ready', ...)`:
     - After `createWindow();`
     - **Await** the splash-ready Promise (e.g. `await splashReadyPromise` or a `waitForSplashReady()` that returns it);
     - Then `await runStartupTasks(mainWindow!);`
     - Then load the main app URL and register `onMainAppReady` as today.
   - Ensure the splash-ready Promise is only resolved once (first `client-ready-for-events`), so the main app’s second `client-ready-for-events` does not break anything (existing `isReadyForEvents` logic can stay as-is).

### 2.2 macOS `activate` edge case (main.ts)

**Problem:** On `app.on('activate')`, when `mainWindow === null`, the code only calls `createWindow()`. It does **not** run `runStartupTasks` or load the main app. The user sees a splash screen that never progresses.

**Change:**

- When recreating the window on activate, run the **same startup flow** as in `app.on('ready')`: after creating the window, wait for splash ready, run `runStartupTasks(mainWindow!)`, then load the main app and register `onMainAppReady`. Extract the “create window + startup tasks + load app” sequence into a shared helper (e.g. `createWindowAndRunStartup()`) and call it from both `app.on('ready')` and `app.on('activate')` when `mainWindow === null`, so behavior is consistent and no duplicate code.

---

## 3. How this fits into existing code

- **Startup flow today:**  
  `app.ready` → `createWindow()` (creates one window, loads `splash.html` with main preload) → `runStartupTasks(mainWindow!)` (sends splash IPC to that window) → load main app URL in same window → `ready-to-show` → `onMainAppReady()` (close splash, attach handlers, show/focus).

- **startup-runner.ts:**  
  When `mainWindow` is passed, `splashTargetWindow = mainWindow` and no separate splash window is created. All `updateSplashStatus` / `updateSplashProgress` go to `mainWindow.webContents`. When `mainWindow` is omitted, a separate splash window is created (legacy). No change needed here.

- **preload.mts:**  
  Same preload runs for both splash and main app in the main window. It forwards `splash-status` / `splash-progress` to CustomEvents and sends `client-ready-for-events` at the end. Splash page listens for those CustomEvents. Fits as-is; only main process must wait for the first `client-ready-for-events` before sending splash IPC.

- **main.ts:**  
  Central place to add: (1) splash-ready Promise + one-time resolver, (2) await splash-ready before `runStartupTasks`, (3) optional shared “create + startup + load app” helper and use it from `ready` and `activate`.

---

## 4. Edge cases to consider

| Edge case | Mitigation |
|-----------|------------|
| **First IPC before splash ready** | Gate `runStartupTasks` on first `client-ready-for-events` (or dedicated splash-ready) so no splash IPC is sent until the preload has run and registered listeners. |
| **Second `client-ready-for-events` (main app load)** | Resolve splash-ready only on first emission; keep existing `isReadyForEvents` and waiters for the main app so `sendIPCMessage` and notifications still work. |
| **Legacy path: `runStartupTasks()` without window** | No change: separate splash window is created; it uses `splash-preload.mts` and doesn’t depend on main-window client-ready. |
| **mainWindow destroyed during startup** | `startup-runner` already checks `!splashTargetWindow.isDestroyed()` before sending. In main, if you await a long-running splash-ready (e.g. user closes window), add a check: if `mainWindow` is null/destroyed after await, skip `runStartupTasks` and subsequent load (or handle gracefully). |
| **macOS activate with no window** | Run the full flow (create → wait splash ready → runStartupTasks → load app) when recreating the window on activate, via a shared helper. |
| **Slow or failing splash load** | Optional: add a timeout to the splash-ready Promise (e.g. 10s) and then start `runStartupTasks` anyway so the app doesn’t hang if the splash never signals; log a warning. |
| **DevTools / debug** | No change; existing `ogiDebug()` and dev tools behavior remain. |

---

## 5. Testing checklist

- **Single-window flow (default / Steam Deck):** Start app → one window shows splash → status/progress update (Restoring backup…, migrations, cleanup, addon reinstall if needed, checking updates, Starting application…) → same window switches to main app. No second splash window.
- **Splash IPC timing:** No splash IPC is sent before the first `client-ready-for-events`; after that, all splash messages are visible on the splash screen.
- **Main app IPC:** After main app load, `client-ready-for-events` still sets `isReadyForEvents`; notifications and other IPC work (e.g. “Addons Starting…”).
- **Legacy path:** If something called `runStartupTasks()` with no argument (e.g. tests), a separate splash window appears and receives the same status/progress.
- **macOS activate:** Close all windows, click dock icon → one window is created, shows splash, runs startup, then shows main app (no stuck splash).
- **Window closed during startup:** If the user closes the main window before splash-ready or during `runStartupTasks`, app doesn’t crash; optional: skip loading main app if `mainWindow` is null after await.

---

## 6. Summary

- **Must change:** `main.ts` — wait for first `client-ready-for-events` (or a dedicated splash-ready) before `runStartupTasks(mainWindow!)`.
- **Should change:** `main.ts` — on `activate`, when recreating the window, run the full startup flow (create → wait splash ready → runStartupTasks → load app) via a shared helper.
- **No change:** `startup-runner.ts`, `preload.mts`, `splash.html`, `splash-preload.mts` for the single-window behavior; only timing and activate flow in main need adjustment.

This plan aligns the implementation with the PR description and closes the remaining gaps for Issue #14 (single-window splash for Steam Deck / Game Mode).
