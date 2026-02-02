# Implementation Plan: Game Launch Statistics & Playtime Analytics

## Overview

Add persistent tracking of game launches and playtime, and surface **most played games** and **playtime analytics** in the Library UI. Recording happens in the main process so it is accurate even when the renderer is closed or the app is minimized.

---

## 1. Files to Create

| File | Purpose |
|------|--------|
| `application/src/electron/handlers/helpers.app/play-statistics.ts` | Load/save play statistics JSON, record session start/end, compute totals. |
| `application/src/frontend/lib/core/play-statistics.ts` | Frontend helpers: load stats via IPC, derive “recently played” and “most played” from stats. |

**Optional (if you want a dedicated stats type in ogi-addon):**

- Add a minimal type in `packages/ogi-addon` for `PlayStatistics` (e.g. `byAppId: Record<number, { totalPlaytimeMs, launchCount, lastPlayedAt }>`). Not strictly required; you can keep types local to the app.

---

## 2. Files to Modify

### 2.1 Main process – recording and storage

| File | Changes |
|------|--------|
| `application/src/electron/handlers/helpers.app/play-statistics.ts` (new) | Implement: `getPlayStatisticsPath()`, `loadPlayStatistics()`, `savePlayStatistics()`, `recordSessionStart(appID)`, `recordSessionEnd(appID)`. Store path: `internals/play-statistics.json`. Data shape: `{ byAppId: Record<string, { totalPlaytimeMs: number, launchCount: number, lastPlayedAt: number }>, activeSession: { appID: number, startTime: number } \| null }`. |
| `application/src/electron/handlers/library-handlers.ts` | In `app:launch-game`: after sending `game:launch`, call `recordSessionStart(appInfo.appID)`. In the `spawnedItem.on('exit', ...)` (and `spawnedItem.on('error', ...)` before sending `game:exit`): call `recordSessionEnd(appInfo.appID)` so every launch has a matching end (normal exit, crash, or error). |
| `application/src/electron/handlers/helpers.app/library.ts` | Optional: add `ensureInternalsDir()` usage from play-statistics so `internals/` exists before writing (or call it from play-statistics and keep library.ts as-is). |

### 2.2 IPC and preload

| File | Changes |
|------|--------|
| `application/src/electron/handlers/handler.app.ts` (or wherever app IPC is registered) | Register handler `app:get-play-statistics` that calls `loadPlayStatistics()` and returns the parsed object (or `{}` if file missing). |
| `application/src/electron/preload.mts` | Expose `getPlayStatistics: () => ipcRenderer.invoke('app:get-play-statistics')` under `electronAPI.app`. |
| `application/src/frontend/global.d.ts` | Add `getPlayStatistics: () => Promise<PlayStatistics>` to the `app` interface and define `PlayStatistics` (or import from a shared types file). |

### 2.3 Frontend – data and “recently / most played”

| File | Changes |
|------|--------|
| `application/src/frontend/lib/core/play-statistics.ts` (new) | Implement: `getPlayStatistics(): Promise<PlayStatistics>`, `getRecentlyPlayedFromStats(library, stats): LibraryInfo[]` (sort by `lastPlayedAt` desc, take first 4), `getMostPlayedFromStats(library, stats): LibraryInfo[]` (sort by `totalPlaytimeMs` desc, optionally cap at 8–10). |
| `application/src/frontend/lib/core/library.ts` | **Option A (recommended):** Add an optional parameter or a separate function that uses play statistics for “recently played” when stats exist (e.g. `getRecentlyPlayed(library, stats?)`). If `stats` is provided, sort by `stats.byAppId[appID].lastPlayedAt` and take first 4; otherwise keep current behavior (apps.json order). **Option B:** Replace current `getRecentlyPlayed` implementation entirely with stats-based order and remove reliance on apps.json for recency (still use apps.json for “library order” elsewhere if needed). |

### 2.4 Frontend – UI

| File | Changes |
|------|--------|
| `application/src/frontend/views/LibraryView.svelte` | Load play statistics (e.g. on mount or when library loads). Use `getRecentlyPlayedFromStats(library, stats)` for the “Recently Played” section when stats exist (otherwise fall back to current `getRecentlyPlayed(library)`). Add a **“Most Played”** section: use `getMostPlayedFromStats(library, stats)`, show same card layout as “Recently Played” (reuse styling). Optionally show per-game playtime (e.g. “12h 34m”) on the card or in a tooltip. |
| `application/src/frontend/components/PlayPage.svelte` | After a successful launch (when `gamesLaunched` is set to `'launched'`), optionally trigger a single refresh of play statistics so that “Most Played” / “Recently Played” can update after a session ends (if you keep stats in component state). Alternatively, refresh stats when returning to Library (e.g. in `LibraryView` when `$selectedApp` becomes undefined or on focus). |
| `application/src/frontend/App.svelte` | If the home/header “recently launched” strip uses `recentlyLaunchedApps`: either (1) keep it as-is (apps.json order) or (2) switch to stats-based order by loading play statistics and deriving recent apps from `lastPlayedAt` (same as LibraryView). |

### 2.5 Game removal and edge cases

| File | Changes |
|------|--------|
| `application/src/electron/handlers/library-handlers.ts` | In `app:remove-app`: optionally call a new helper `removeAppFromPlayStatistics(appID)` that deletes that key from `byAppId` and clears `activeSession` if it referred to that app. Keeps stats file consistent when a game is removed. |

---

## 3. Data Shape and Storage

**Path:** `{__dirname}/internals/play-statistics.json` (same base as `apps.json`).

**Schema:**

```ts
interface PlayStatistics {
  byAppId: Record<string, {
    totalPlaytimeMs: number;
    launchCount: number;
    lastPlayedAt: number;  // Unix ms
  }>;
  activeSession: {
    appID: number;
    startTime: number;     // Unix ms
  } | null;
}
```

- **Session:** On `game:launch`, set `activeSession = { appID, startTime: Date.now() }`. On `game:exit` (or launch error), compute `durationMs = Math.max(0, Date.now() - startTime)`, add to `byAppId[appID].totalPlaytimeMs`, increment `launchCount`, set `lastPlayedAt = Date.now()`, then set `activeSession = null`.
- **Sanity cap:** Optionally cap `durationMs` (e.g. `Math.min(durationMs, 24 * 60 * 60 * 1000)`) to avoid huge values if the system clock changes or the app is left running across sleep.

---

## 4. How It Fits Into Existing Code

- **Launch flow (unchanged from caller’s perspective):**  
  `PlayPage` / `StorePage` → `window.electronAPI.app.launchGame(appid)` → main `app:launch-game` → `exec()` + `game:launch` / `game:exit`. You only add calls to `recordSessionStart` and `recordSessionEnd` inside that handler.

- **“Recently Played”:**  
  Today this is “first N in apps.json order,” and PlayPage already moves the launched game to the front of apps.json. You can keep that for “library order” and use **stats** only for “recently played” and “most played” ordering. So: `getRecentlyPlayed(library, stats)` uses `lastPlayedAt` when stats exist; otherwise falls back to current behavior.

- **Library view:**  
  Already has “Recently Played” and “All Games.” You add a **“Most Played”** section (and optionally playtime on cards) using the same `library` and the new `getPlayStatistics()` + `getMostPlayedFromStats()`.

- **Existing events:**  
  `game:launch` and `game:exit` already fire from the main process; no change to GameManager or preload event wiring. Only the main process handler that already runs on launch/exit does the extra persistence.

- **Backup:**  
  `updater.ts` already backs up `internals`; `play-statistics.json` will be included automatically.

---

## 5. Edge Cases to Consider

| Edge case | Handling |
|-----------|----------|
| **Game exits (crash or kill)** | Main process still receives `spawnedItem.on('exit')` (and `on('error')`). Call `recordSessionEnd` in both so every launch is closed out. |
| **App quit while game is running** | Process exit may not run `recordSessionEnd`. On next startup, if `activeSession` is non-null, you can either: (1) treat it as a lost session (do nothing, or add duration up to “now” with a cap), or (2) run a small “reconcile” on load that closes any stale `activeSession` with a capped duration. Option (2) avoids unbounded growth of `activeSession`. |
| **Game removed from library** | In `app:remove-app`, remove that app from `byAppId` and clear `activeSession` if it matches, so the stats file doesn’t reference removed apps. |
| **Clock skew / system sleep** | Cap session duration (e.g. 24h) when calling `recordSessionEnd` to avoid negative or huge values. |
| **Missing or corrupt stats file** | `loadPlayStatistics()` returns `{ byAppId: {}, activeSession: null }` and overwrites a bad file on next write, or leave file and only merge new sessions into a default object. |
| **First run / no stats** | No file → load returns default empty structure; “Recently Played” and “Most Played” fall back to current behavior (or empty “Most Played”) until first sessions are recorded. |
| **Concurrent launches** | Only one game is launched at a time in the current flow; `activeSession` is single. If you ever support multiple processes per app, you’d need a list of active sessions keyed by appID (out of scope for this plan). |
| **Renderer closed during play** | Recording is in main process only, so sessions are still closed when the game process exits. |
| **Steam/Proton launch path** | If some games are launched via Steam (e.g. Proton) and never go through `app:launch-game`, they won’t be in stats. That’s acceptable unless you add a separate integration later. |

---

## 6. Implementation Order (Suggested)

1. **Main:** Add `play-statistics.ts` helper (path, load, save, record start/end, optional reconcile on load for stale `activeSession`).
2. **Main:** In `library-handlers.ts`, call `recordSessionStart` after sending `game:launch` and `recordSessionEnd` in both `exit` and `error` before sending `game:exit`.
3. **IPC:** Add `app:get-play-statistics`, preload, and `global.d.ts` types.
4. **Frontend:** Add `play-statistics.ts` with `getPlayStatistics`, `getRecentlyPlayedFromStats`, `getMostPlayedFromStats`.
5. **Frontend:** Update `library.ts` so “recently played” can use stats when available.
6. **UI:** In `LibraryView.svelte`, load stats, wire “Recently Played” to stats-based list when possible, add “Most Played” section and optional playtime on cards.
7. **Cleanup:** In `app:remove-app`, remove app from play statistics.
8. **Optional:** Reconcile stale `activeSession` on app startup in main process.

---

## 7. Minimal UI Copy Suggestions

- **Section title:** “Most Played” (or “Most played”).
- **Playtime on card:** e.g. “24h total” or “12h 34m” under the game name for “Most Played” cards; “Recently Played” can show “Last played: 2h ago” or just keep current look.
- **Empty state:** If there are no stats yet, “Most Played” can be hidden or show “Play games to see your most played titles.”

This keeps the feature consistent with the existing library, internals, and launch flow while adding clear, maintainable statistics and analytics surfaces.
