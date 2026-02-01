# Pull Request: Game update check refactor & library update UI

## Summary

This PR refactors game update checking by moving logic into a dedicated `lib/updates` module and wiring it to both startup (after addons are ready) and the Library "Check for updates" action. It also introduces persisted update state (e.g. `requiredReadds`) and a Library UI that shows update badges and last-check results.

## Key Modifications

- **`application/src/frontend/lib/updates/` (new)**  
  - **`checkGameUpdates.ts`**: Single entry point for running the game update check. Clears current app update state, fetches the library, and for each app calls the addon `checkForUpdates` procedure (appID, storefront, currentVersion), then records available updates via `updatesManager`. Returns `{ updatesFound }`. Used by AppUpdateManager on startup and by LibraryView for the manual check.

- **`AppUpdateManager.svelte`**  
  - Reduced to a thin wrapper: listens for `all-addons-started`, then calls `checkGameUpdates()` from the new lib and logs completion. No inline update-check logic.

- **`states.svelte.ts`**  
  - **Persisted update state:** `loadPersistedUpdateState()` reads `./internals/update-state.json` and returns `{ requiredReadds }` (validated `appID` / `steamAppId` entries).  
  - **Reactive persistence:** An effect tracks `appUpdates.requiredReadds` and writes it to `./internals/update-state.json` (with a 1s initial delay and proper cleanup).  
  - **Game update UI state:** `gameUpdatesCheckState` (isChecking, lastResult) and `updatesManager` (clearAppUpdates, setCheckingForGameUpdates, setLastGameUpdatesCheckResult, addAppUpdate, removeAppUpdate, getAppUpdate) support the Library check button and badges.

- **`LibraryView.svelte`**  
  - Imports `checkGameUpdates` from `lib/updates/checkGameUpdates`.  
  - **"Check for updates" button:** Disabled when checking or when library is empty; shows spinner and "Checking…" while running; after completion shows "X update(s) available" or "All games up to date".  
  - **Update badges:** Recently played and All Games tiles show an update badge when `updatesManager.getAppUpdate(app.appID)?.updateAvailable` is true.  
  - **Notification:** When the check finds updates, creates an info notification with the count.

## Testing Notes

- **Startup:** After addons have started, a single game update check should run automatically; console should log "startup game update check complete".
- **Library – Check for updates:** With at least one game, click "Check for updates". Button should show spinner and "Checking…", then show "X update(s) available" or "All games up to date"; if updates exist, an info notification should appear and library tiles with updates should show the update badge.
- **Library – empty:** With no games, "Check for updates" should be disabled.
- **Persistence:** `./internals/update-state.json` should be created/updated when `requiredReadds` changes; after restart, `loadPersistedUpdateState()` (used from App.svelte) should restore requiredReadds so dependent UI (e.g. PlayPage, GameConfiguration) behaves correctly.

## Breaking Changes

None. New module and state are additive; existing consumers of `appUpdates` and `requiredReadds` (App.svelte, PlayPage, GameConfiguration, setup) continue to work. No data migrations required beyond the existing update-state.json format and migrations that already handle `requiredReadds`.
