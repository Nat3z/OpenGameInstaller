# Implementation Plan: Native Cloud Save (Sync Through OGI)

This document outlines a detailed implementation plan for the **Native cloud save** feature: game save data syncing through OpenGameInstaller so that "they all could sync through this."

---

## 1. Overview

**Goal:** Allow users to sync game save data across devices through OGI. When a game is launched, optionally pull the latest cloud save; when the game exits, optionally push local saves to the cloud. All games can use this single, native sync path.

**Architecture summary:**
- **Data model:** Per-game save path config (one or more local paths to sync), stored alongside library data.
- **Storage:** Sync backend (OGI-hosted or configurable). Save data is compressed and stored keyed by user + appID (and optionally slot/version).
- **Lifecycle:** Pre-launch download (optional), post-exit upload (optional), with conflict handling and user settings.

---

## 2. Files to Modify or Create

### 2.1 New Files

| Path | Purpose |
|------|--------|
| `application/src/electron/manager/manager.cloudsave.ts` | Cloud save config read/write, path resolution, and coordination with sync service. |
| `application/src/electron/handlers/handler.cloudsave.ts` | IPC handlers for cloud save: get/set config, trigger sync, status. |
| `application/src/electron/lib/cloudsave-sync.ts` | Core sync logic: pack local paths → upload, download → unpack. Uses fs, optional backend client. |
| `application/src/frontend/lib/cloudsave/client.ts` | Frontend API: invoke IPC for config and sync, subscribe to sync status. |
| `application/src/frontend/views/CloudSaveSettings.svelte` | Settings UI: enable/disable cloud save globally, per-game paths, conflict strategy. |
| `application/src/frontend/components/PlayPageCloudSaveBanner.svelte` | Small banner on PlayPage: "Cloud save: last synced …" / "Sync now" / "Download before launch". |
| `packages/ogi-addon/src/main.ts` (additions) | Optional `cloudSavePaths` in `SetupEventResponse` and types so addons can declare save locations. |
| `docs/implementation-plan-native-cloud-save.md` | This plan. |

Optional backend (if OGI hosts sync):
- New repo or `web/` API routes for: `PUT /api/cloud-save/:appID`, `GET /api/cloud-save/:appID`, auth (e.g. OGI account or token). Not specified in detail here; can be a follow-up phase.

### 2.2 Files to Modify

| Path | Changes |
|------|--------|
| `packages/ogi-addon/src/main.ts` | Extend `SetupEventResponse` with optional `cloudSavePaths?: { name: string; path: string }[]`. Extend `ZodLibraryInfo` and `LibraryInfo` with optional `cloudSavePaths` and `cloudSaveEnabled?: boolean` (or keep path config in a separate store, see below). |
| `application/src/electron/helpers.app/library.ts` | When loading/saving library info, include new cloud-save fields if stored on LibraryInfo; or call into manager.cloudsave for per-app config. |
| `application/src/electron/handlers/library-handlers.ts` | After game exit (`app:launch-game` child exit), call cloud save upload hook (if enabled for that app). Optionally before launch, call download hook. |
| `application/src/electron/handlers/handler.app.ts` | Register cloud save handlers: `registerCloudSaveHandlers(mainWindow)`. |
| `application/src/electron/preload.mts` | Expose `cloudsave` API: `getConfig`, `setConfig`, `syncDown`, `syncUp`, `getLastSync`, subscribe to `cloudsave:status`. |
| `application/src/frontend/global.d.ts` | Add `electronAPI.cloudsave` typings. |
| `application/src/frontend/components/PlayPage.svelte` | Add optional "Cloud save" section or banner (e.g. PlayPageCloudSaveBanner), "Download before play" button if cloud save enabled. |
| `application/src/frontend/views/ConfigView.svelte` or settings flow | Link or tab to Cloud Save settings (CloudSaveSettings.svelte). |
| `application/src/electron/migrations.ts` | Optional migration: ensure `config/option/cloudsave.json` exists with default (e.g. enabled: false), or migrate legacy per-app flags. |

---

## 3. Specific Changes

### 3.1 Data Model

**Option A – Store on LibraryInfo (addon-friendly):**
- In `ogi-addon`, add to `ZodLibraryInfo`:
  - `cloudSavePaths: z.array(z.object({ name: z.string(), path: z.string() })).optional()`
  - `cloudSaveEnabled: z.boolean().optional()`
- Addons can set `cloudSavePaths` in setup response (paths relative to install or absolute). User can override in UI.

**Option B – Separate config (simpler schema change):**
- Keep `LibraryInfo` unchanged. Add `config/option/cloudsave.json`:
  - `{ "enabled": boolean, "perGame": { [appID]: { "paths": { name, path }[], "enabled": boolean } } }`
- Paths can still be suggested by addon via a different channel (e.g. stored in library manifest or a separate addon response) and copied into this config by the app.

**Recommendation:** Option B for v1 (no ogi-addon schema change for LibraryInfo), with a later optional addon extension to suggest paths. Per-game config path: `config/cloudsave/<appID>.json` or single `config/option/cloudsave.json` with `perGame` key.

**Sync payload (backend):**
- Key: `userId` (or device token) + `appID`. Optional: `slot` (e.g. save slot 1/2/3).
- Value: Tarball or zip of the contents of the configured paths, plus a small manifest (e.g. lastModified, list of files). Stored in OGI backend or user-configured (S3/Nextcloud) later.

### 3.2 Manager and Helpers (Electron)

**manager.cloudsave.ts**
- `getCloudSaveConfig()`: read global + per-game config from `config/option/cloudsave.json` (and optional per-app files).
- `setCloudSaveConfig(config)`: write config.
- `getPathsForApp(appID: number)`: return list of absolute paths to sync for this game (resolve relative to library entry `cwd` or given base).
- `getLastSyncTime(appID)`: read from `internals/cloudsave-last.json` or similar.
- `setLastSyncTime(appID, direction: 'up' | 'down', time)`.

**handler.cloudsave.ts**
- `cloudsave:get-config` → getCloudSaveConfig().
- `cloudsave:set-config` → setCloudSaveConfig().
- `cloudsave:sync-down` (appID) → run sync download for appID; send progress/status via `cloudsave:status`.
- `cloudsave:sync-up` (appID) → run sync upload for appID; same.
- `cloudsave:get-last-sync` (appID) → getLastSyncTime(appID).

**cloudsave-sync.ts**
- `uploadSave(appID, paths: string[])`: zip paths (with safe names), upload to backend, update last-sync.
- `downloadSave(appID)`: fetch from backend, unzip into a temp dir, then copy into configured paths (with safety checks: path must be under allowed roots).
- Use existing fs helpers and `__dirname` / library paths; no direct dependency on renderer.

### 3.3 Library and Game Lifecycle Integration

**library-handlers.ts – `app:launch-game`:**
1. (Optional) If cloud save is enabled for this appID, call `syncDown(appID)` (or queue it and show "Syncing saves…" in UI). Wait for completion or timeout before `exec()`.
2. On child `exit` (and optionally on `error`): if cloud save enabled for this appID, call `syncUp(appID)` in background; notify renderer via `cloudsave:status` when done.

**GameManager.svelte**
- Subscribe to `cloudsave:status` (e.g. "upload complete" for appID) and update UI or a small store (e.g. lastSyncByApp) so PlayPage can show "Last synced …".

### 3.4 Frontend

**CloudSaveSettings.svelte**
- Global toggle: "Enable cloud save".
- List of library games with cloud save enabled; for each, show/add/remove "save paths" (dir or file). Paths can be picked via `fs:dialog:show-open-dialog` (directory).
- Conflict strategy: "Last write wins" / "Always ask" (future).
- "Sync now" per game or for all.

**PlayPage / PlayPageCloudSaveBanner**
- If cloud save enabled for this game: show last sync time; button "Download cloud save" before play; after exit, show "Uploading save…" then "Saved to cloud".

**Config view**
- Add entry "Cloud save" that opens CloudSaveSettings or an inline section.

### 3.5 Addon Contract (Optional)

- In `SetupEventResponse`, add optional `cloudSavePaths?: { name: string; path: string }[]`. Paths can be relative to `cwd` or absolute. OGI app, when saving library entry, can copy these into the local cloud-save config so the user sees them pre-filled and can edit.

---

## 4. How It Fits Into Existing Code

- **Config:** Uses the same pattern as `config/option/general.json`, `realdebrid.json` (manager.config, fs read/write under `__dirname`). New file `config/option/cloudsave.json`.
- **Library:** Reads `LibraryInfo` and `cwd` from existing `loadLibraryInfo` / `getLibraryPath` to resolve relative save paths. No change to `library/<appID>.json` format unless Option A is used.
- **IPC:** Same style as `handler.realdebrid.ts`, `handler.app.ts` – expose in preload under `electronAPI.cloudsave` and call from Svelte.
- **Game lifecycle:** Reuses `app:launch-game` and the existing `game:exit` event; adds a post-exit hook in main process and optional pre-launch sync in the same handler.
- **UI:** Follows existing ConfigView / modal patterns; PlayPage already has game-specific UI, so a small cloud-save block fits there.
- **Backend:** If OGI provides the backend, it can be a simple REST API (auth via existing or new token); the Electron side uses `app:axios` or a dedicated module to avoid CORS. No change to addon server or WebSocket.

---

## 5. Edge Cases to Consider

1. **Path safety**
   - Resolve all sync paths to absolute and ensure they lie under the game’s `cwd` or a user-allowed list (e.g. Documents). Reject paths that escape (e.g. `../..`) to avoid leaking or overwriting system files.

2. **Game exit detection**
   - Only the main process sees the child process exit. If the game spawns a launcher that then spawns the real process, exit may fire when the launcher exits, not when the real game exits. Consider: document that "sync on exit" runs when the process started by OGI exits; optional "sync on a timer while game is running" is a later enhancement.

3. **Concurrent edits**
   - User plays on two devices: last upload wins unless a conflict strategy is implemented. For v1, last-write-wins with a "last synced at" timestamp is enough; optional "merge" or "ask user" can be added later.

4. **Large saves**
   - Some games have huge save folders. Add limits (e.g. max total size per app, or per-path size), progress reporting, and optional compression to avoid timeouts and storage blow-up.

5. **Offline / backend down**
   - If upload fails, keep last-sync state and retry on next exit or on "Sync now". Don’t block launch if download fails; optionally warn "Could not download cloud save; use local save?".

6. **First-time enable**
   - When user enables cloud save for a game that already has local saves, first action should be "upload" (backup current state) so the cloud has a baseline before any download.

7. **Uninstall / remove app**
   - When a game is removed from library, optionally ask "Delete cloud save for this game?" and clear backend slot and local config.

8. **Platform differences**
   - Save paths differ on Windows vs Linux (e.g. Wine prefix vs native). Store paths per platform or use addon-provided paths per platform; manager resolves based on `process.platform`.

9. **Migration**
   - If later you add a proper backend, migration from "no backend" or from a file-based prototype should not break existing `config/option/cloudsave.json` (only add new keys).

10. **Privacy and security**
    - Save files may contain sensitive data. Backend must be HTTPS and ideally user-authenticated; consider documenting that users should only enable cloud save if they trust the storage.

---

## 6. Implementation Order (Suggested)

1. **Phase 1 – Config and plumbing**
   - Add `config/option/cloudsave.json` schema and manager.cloudsave.ts (get/set config, getPathsForApp).
   - Add handler.cloudsave.ts and preload + global.d.ts. No real sync yet.

2. **Phase 2 – Sync logic**
   - Implement cloudsave-sync.ts (upload/download) against a stub or real backend (e.g. simple file store or minimal API). Integrate into library-handlers (post-exit upload, optional pre-launch download).

3. **Phase 3 – UI**
   - CloudSaveSettings.svelte and Config entry; PlayPage banner and "Download before play" / "Sync now".

4. **Phase 4 – Addon and polish**
   - Optional `cloudSavePaths` in addon setup; migrations; conflict and size limits; documentation.

This keeps schema and API stable while allowing an iterative rollout and backend decisions (OGI-hosted vs user-provided) to be made in parallel.
