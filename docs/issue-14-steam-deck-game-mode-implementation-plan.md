# Issue #14: Steam Deck Game Mode Integration — Implementation Plan

## Summary

The reporter sees OGI’s square loading screen (splash) and then a **black screen** when launching the AppImage from Steam in Game Mode (or Big Picture). The codebase already uses a **single-window flow** (splash then main app in the same `BrowserWindow`) to avoid multiple windows. The remaining problem is that the **main app “ready” callback is tied to an event that does not fire again** after the second load, so handlers never run and the window is never re-focused. Fixing that, plus a few small Steam Deck–friendly tweaks, should resolve the issue.

---

## 1. Root cause

- **Single-window flow (current):**  
  One `BrowserWindow` is created, it loads `splash.html` first, shows when splash is ready, then `runStartupTasks(mainWindow)` runs, then the same window loads the main app URL. The intent is that when the main app has loaded, `onMainAppReady()` runs (register handlers, `closeSplashWindow()`, `show()`, `focus()`).

- **Bug:**  
  The main app load uses **`mainWindow.once('ready-to-show', onMainAppReady)`**.  
  In Electron, **`ready-to-show`** is emitted when the page is first rendered **and the window has not been shown yet**. After the window is already shown (for splash), a **second** load (main app) typically **does not** emit `ready-to-show` again. So `onMainAppReady()` never runs:
  - IPC handlers (app, FS, RealDebrid, torrent, etc.) are never registered.
  - `mainWindow.show()` / `mainWindow.focus()` are never called again (important for Steam/gamescope focus).
  - The user can see a black or blank window because the “ready” logic never runs.

So the black screen is caused by **relying on `ready-to-show` for the second navigation**; that event is not guaranteed (and often not) fired for an already-shown window.

---

## 2. Files to modify

| File | Purpose |
|------|--------|
| `application/src/electron/main.ts` | Fix main-app “ready” detection; optional Steam Deck tweaks (e.g. `backgroundColor`, focus). |
| (Optional) `application/public/splash.html` | Optional: match splash background to app so transition is seamless. |

No changes are required to `startup-runner.ts`, preloads, or splash IPC: the single-window flow and splash updates are already correct.

---

## 3. Specific code changes

### 3.1 Use `did-finish-load` for main app ready (critical)

**File:** `application/src/electron/main.ts`

**Current (buggy):**

- After `mainWindow!!.loadURL(...)` for the main app (dev or prod), the code registers:
  - `mainWindow!!.once('ready-to-show', onMainAppReady);`
- Because the window was already shown for splash, `ready-to-show` may never fire again, so `onMainAppReady` never runs.

**Change:**

- Do **not** rely on `ready-to-show` for the **second** load.
- Use **`webContents.once('did-finish-load', onMainAppReady)`** for the main app load.  
  `did-finish-load` is emitted when the navigation (including the main app URL) finishes, so it will run after the main app page has loaded.

**Implementation details:**

1. Remove:
   - `mainWindow!!.once('ready-to-show', onMainAppReady);`
2. Add, **after** calling `mainWindow!!.loadURL(...)` for the main app (both dev and prod branches):
   - `mainWindow!!.webContents.once('did-finish-load', onMainAppReady);`
3. Ensure `onMainAppReady` is only ever run once (e.g. no double registration). Using `.once()` satisfies this.

**Exact location:** In the `app.on('ready', async () => { ... })` block, after the `if (isDev()) { ... } else { ... }` that calls `mainWindow!!.loadURL(...)`, replace the single line that registers `ready-to-show` with the `webContents.once('did-finish-load', ...)` registration.

### 3.2 Ensure window is shown and focused (Steam / Game Mode)

**File:** `application/src/electron/main.ts`

- `onMainAppReady()` already calls `mainWindow!!.show()` and `mainWindow!!.focus()`. Once `onMainAppReady` is reliably run (via `did-finish-load`), this will work.
- Optional: on Linux, call `mainWindow!!.moveTop()` after `focus()` so the window is clearly on top in gamescope (e.g. Steam Deck). Only add if needed; try without first.

### 3.3 Avoid flash / black flash (optional)

**File:** `application/src/electron/main.ts` — `createWindow()`

- Set **`backgroundColor`** on the main `BrowserWindow` to match the app’s background (e.g. `#1a1a1a` or whatever the renderer uses). This reduces any brief black flash during load or transition, especially on Steam Deck.
- Example: add to `BrowserWindow` options: `backgroundColor: '#1a1a1a'` (adjust to match your UI).

**File:** `application/public/splash.html` (optional)

- If the app uses a dark theme, set the splash `body` background to the same color so the transition from splash to main app has no visible flash.

---

## 4. How this fits the existing architecture

- **Single-window flow:** Already in place: one `BrowserWindow`, splash first, then main app in the same window. No architectural change.
- **Splash:** `runStartupTasks(mainWindow)` already uses `splashTargetWindow = mainWindow`, so no separate splash window is created; splash IPC is received by the main window. The main preload already forwards `splash-status` / `splash-progress` to the DOM. No change needed.
- **Main app readiness:** Today the “main app is ready” signal is `ready-to-show`. The fix only changes that signal to `did-finish-load` for the **main app** load. All existing behavior in `onMainAppReady()` (closeSplashWindow, register handlers, show, focus, etc.) stays the same; it just runs reliably.
- **Handlers:** All IPC and app handlers remain registered in `onMainAppReady()` as they are now.

---

## 5. Edge cases and considerations

1. **Multiple `did-finish-load` events**  
   Use **`.once()`** so `onMainAppReady` runs only once. No need to check URL if the listener is attached immediately before/after the single `loadURL(mainApp)` call.

2. **Load failure**  
   If the main app URL fails to load, `did-finish-load` may still fire (e.g. error page). Consider:
   - Listening for `did-fail-load` and showing an error UI or retry, and/or
   - In `onMainAppReady`, checking `mainWindow.webContents.getURL()` to ensure we’re on the expected app URL before running the rest of the logic (optional hardening).

3. **macOS `activate`**  
   The `app.on('activate', ...)` path calls `createWindow()` only when `mainWindow === null` (window was closed). That path does not run startup or load the main app again; it’s a separate “reopen window” flow. No change required for Issue #14; can be improved later if desired.

4. **Steam Deck / Wayland**  
   No Wayland-specific code is required for this fix. If future issues appear (e.g. focus or fullscreen in gamescope), consider:
   - `mainWindow.moveTop()` after focus,
   - Or researching gamescope/SteamOS window type hints if needed.

5. **Updater**  
   The separate updater process (e.g. `updater/src/main.js`) launches the main app in a new process; it does not share the main window. The fix is entirely inside the main application window lifecycle.

6. **Dev vs prod**  
   Apply the same “main app ready” logic for both:
   - `mainWindow!!.loadURL('http://localhost:8080/...')` (dev)
   - `mainWindow!!.loadURL('file:///.../index.html...')` (prod)  
   Use one `webContents.once('did-finish-load', onMainAppReady)` after the branch that calls `loadURL`.

---

## 6. Testing

- **Desktop (Linux / Windows / macOS):** Launch app; splash should show, then main app should appear and be fully functional (no black screen).
- **Steam Deck Game Mode:** Add OGI as non-Steam game (via AppImageLauncher workflow), launch from Game Mode; should see splash then main app, no black screen, window focused and usable.
- **Big Picture:** Same as Game Mode if possible.
- **Regression:** Ensure no double registration of handlers, no duplicate windows, and that splash still updates during startup when main window is used for splash.

---

## 7. Checklist

- [ ] In `main.ts`, remove `mainWindow!!.once('ready-to-show', onMainAppReady)`.
- [ ] In `main.ts`, after `mainWindow!!.loadURL(...)` for the main app (both dev and prod), add `mainWindow!!.webContents.once('did-finish-load', onMainAppReady)`.
- [ ] (Optional) Set `backgroundColor` on the main `BrowserWindow` in `createWindow()` to match app theme.
- [ ] (Optional) Align splash.html background color with app theme.
- [ ] Test on desktop and, if available, Steam Deck Game Mode / Big Picture.

This plan addresses the “loading screen then black” behavior by ensuring the main app’s ready callback always runs after the second load, so the window is shown, focused, and fully wired for Steam Deck Game Mode.
