# Uninstall App Functionality — Implementation Plan

## Summary

**Current behavior:** "Remove from Library" (`app:remove-app`) only removes the game from the app's library (deletes `library/{appID}.json` and removes the app from `internals/apps.json`). **Game files on disk are left intact.**

**New feature:** "Uninstall App" will **delete the game's installation directory from disk** and then remove the game from the library (same as remove-app). This is irreversible.

---

## 1. Files to Modify or Create

### Backend (Electron)

| File | Action |
|------|--------|
| `application/src/electron/handlers/library-handlers.ts` | **Modify** — Add `app:uninstall-app` IPC handler. |
| `application/src/electron/handlers/helpers.app/library.ts` | **Modify** (optional) — Add helper `deleteGameDirectory(cwd: string)` and path-safety validation, or keep logic in handler. |
| `application/src/electron/preload.mts` | **Modify** — Expose `uninstallApp(appid: number)` on `window.electronAPI.app`. |

### Frontend

| File | Action |
|------|--------|
| `application/src/frontend/global.d.ts` | **Modify** — Add `uninstallApp(appid: number): Promise<...>` to `electronAPI.app`. |
| `application/src/frontend/components/built/UninstallAppWarningModal.svelte` | **Create** — Confirmation modal (pattern: `DeleteAddonWarningModal.svelte`). |
| `application/src/frontend/components/StorePage.svelte` | **Modify** — Add "Uninstall" action (and optionally keep "Remove from Library"). |
| `application/src/frontend/components/GameConfiguration.svelte` | **Modify** — Add "Uninstall (delete files)" option alongside "Remove Game". |
| `application/src/frontend/components/PlayPage.svelte` | **Modify** (optional) — Add uninstall entry point from library game detail (e.g. in a menu or next to Settings). |

### Documentation

| File | Action |
|------|--------|
| `docs/UNINSTALL_APP_IMPLEMENTATION_PLAN.md` | **Create** — This file. |

---

## 2. Specific Changes

### 2.1 Backend: New IPC handler `app:uninstall-app`

**Location:** `application/src/electron/handlers/library-handlers.ts`

- Add handler after `app:remove-app`:
  - Load library info with `loadLibraryInfo(appid)`. If missing, return error (e.g. `{ success: false, error: 'app-not-found' }`).
  - **Path safety:** Resolve and validate `appInfo.cwd`:
    - If `cwd` is relative (e.g. starts with `./`), resolve against `__dirname` (same as fs handlers).
    - Reject if resolved path is outside a safe set (e.g. not under `__dirname`, or not under a known "game install roots" list). Reject paths like `/`, `/home`, `C:\`, etc. to avoid catastrophic deletion.
  - Delete the game directory: use `fs.promises.rm(resolvedCwd, { recursive: true, force: true })` (main process) so path resolution is consistent and you can validate before calling. Do **not** call `fs:delete` from renderer with user-controlled `cwd` without validation in main.
  - On success: call `removeLibraryFile(appid)` and `removeFromInternalsApps(appid)` (same as remove-app).
  - Return `{ success: true }` or `{ success: false, error: string }`.
  - On delete failure (e.g. permission, in use): still remove from library and return error so UI can show "Removed from library but some files could not be deleted."

**Path safety helper (recommended in `helpers.app/library.ts` or next to handler):**

- `function isSafeToDeleteGamePath(cwd: string, appDataDir: string): boolean`
  - Resolve `cwd` to absolute (if relative, resolve against `appDataDir`).
  - Ensure resolved path does not escape expected roots: e.g. must be under `appDataDir` or under a configurable list of allowed install roots (e.g. from config). Reject if it equals or is ancestor of system dirs (`/`, `os.homedir()` as root only if you allow installs there), or if `path.relative(allowedRoot, resolved)` starts with `..`.

### 2.2 Preload and types

**`application/src/electron/preload.mts`**

- In `app` object, add:
  - `uninstallApp: wrap((appID: number) => ipcRenderer.invoke('app:uninstall-app', appID))`

**`application/src/frontend/global.d.ts`**

- In `electronAPI.app`, add:
  - `uninstallApp: (appid: number) => Promise<{ success: boolean; error?: string }>;`

### 2.3 Uninstall confirmation modal

**Create:** `application/src/frontend/components/built/UninstallAppWarningModal.svelte`

- Mirror structure of `DeleteAddonWarningModal.svelte`: props `open`, `onClose`, `gameName`, `onConfirm` (callback that performs uninstall).
- Title: e.g. "Uninstall Game".
- Body: "Are you sure you want to uninstall '{gameName}'? This will **delete all game files from disk** and remove the game from your library. This action cannot be undone."
- Buttons: "Cancel" (onClose), "Uninstall" (danger, calls onConfirm then onClose on success).

### 2.4 StorePage.svelte

- Where "Remove from Library" is shown (e.g. for `alreadyOwns` and `isWin32Only`, or in a shared actions area):
  - Add a second button "Uninstall" (or "Uninstall (delete files)") that:
    - Opens `UninstallAppWarningModal` with `gameName={gameData.name}`, `onConfirm` calling `window.electronAPI.app.uninstallApp(appID)`.
    - On success: same post-actions as `removeGame()` — notification, `currentDownloads.update` filter by appID, `loadCustomStoreData()`.
    - On failure: show notification with `error` message.
  - Keep "Remove from Library" as-is for users who only want to hide the game without deleting files.

### 2.5 GameConfiguration.svelte

- In the modal section with "Remove Game" and "Cancel":
  - Add "Uninstall (delete files)" button (variant danger) that:
    - Opens uninstall confirmation modal (or inline confirm), then calls `uninstallApp(gameInfo.appID)`.
    - On success: same as `removeFromList()` — notification, update `currentDownloads`, call `exitPlayPage()`.
  - Keep "Remove Game" for remove-from-library-only.

### 2.6 PlayPage.svelte (optional)

- Add an "Uninstall" or "Manage" area that opens a small menu or second modal offering "Uninstall game (delete files)" using the same modal and `uninstallApp(libraryInfo.appID)`, then exit play page and refresh library.

---

## 3. How It Fits Into Existing Code

- **Library model:** Uninstall reuses the same library model as remove-app: `LibraryInfo.cwd` is the installation directory; `removeLibraryFile` and `removeFromInternalsApps` already exist. Uninstall = delete `cwd` on disk + then do what remove-app does.
- **IPC pattern:** Same as `app:remove-app` and `app:get-all-apps` — main process owns file and library state; renderer only calls IPC.
- **UI pattern:** Same as addon delete: confirmation modal → invoke backend → notifications and store updates. Reuse `createNotification` and download/store refresh patterns from `removeGame()` and `removeFromList()`.
- **Path resolution:** Game `cwd` can be absolute or relative; main process should resolve relative paths against the same app data dir used by fs handlers (`__dirname` from `manager.paths`). Do not pass raw `cwd` from renderer to `fs:delete`; implement uninstall entirely in main and only expose `app:uninstall-app(appid)` so path validation is in one place.

---

## 4. Edge Cases to Consider

| Edge case | Recommendation |
|-----------|-----------------|
| **Path safety** | Validate resolved `cwd` so it cannot delete system or home root. Only allow deletion under app data dir or a configurable list of allowed install roots. |
| **Game directory missing** | If `cwd` does not exist, still remove from library and return success (treat as "already uninstalled"). |
| **Delete fails (permission, in use, etc.)** | Remove from library anyway so the app no longer shows the game; return `{ success: false, error: '...' }` and show a notification so user knows some files were left behind. |
| **Game currently running** | Optionally check for process using `cwd` and warn or block; otherwise allow uninstall and document that deleting while running may cause undefined behavior. |
| **Steam shortcut** | Do **not** delete Steam compat data or Steam shortcut in this feature (Proton prefix may be shared; Steam shortcut removal would require steamtinkerlaunch/Steam API support). Document that the user can remove the non-Steam game from Steam manually. |
| **Persisted download records** | Leave download persistence as-is; do not try to match `cwd` to download paths and delete those records (different lifecycle; optional follow-up). |
| **Concurrent uninstall/remove** | If user clicks Uninstall and Remove quickly, both could run; handler can load library once and remove from library only once; idempotent library removal is fine. |
| **Linux sandbox / path** | On Linux, `__dirname` may be under `~/.local/share/OpenGameInstaller`; ensure `cwd` resolved against it still passes the "safe to delete" check. |
| **Windows path casing** | Use consistent normalization (e.g. `path.resolve`) before comparison and deletion. |
| **Modal closing on success** | After successful uninstall, close the confirmation modal and the game config modal (if open) and navigate/refresh so the game no longer appears. |

---

## 5. Implementation Order

1. **Backend:** Path safety helper + `app:uninstall-app` in library-handlers, then preload + global.d.ts.
2. **Frontend:** Create `UninstallAppWarningModal.svelte`.
3. **Integration:** Add uninstall to StorePage (game detail), then GameConfiguration, then PlayPage if desired.
4. **Testing:** Install a game, uninstall (verify directory gone and library entry removed), then test "Remove from Library" still works and leaves files.

---

## 6. Optional Follow-ups

- **Remove from Steam:** If steamtinkerlaunch (or Steam) exposes "remove non-Steam shortcut," add an optional step in uninstall or a separate "Remove from Steam only" action.
- **Configurable "allowed install roots":** Allow users to set a list of directories under which game installs are allowed; use that in `isSafeToDeleteGamePath`.
- **Trash instead of delete:** On supported OS, move to trash (e.g. `shell.moveItemToTrash`) instead of permanent delete; document in UI.
