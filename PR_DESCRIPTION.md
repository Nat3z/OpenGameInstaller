# Pull Request: Fix black screen on Steam Deck Game Mode (Issue #14)

## Summary

This PR fixes the black screen that appears when launching the OpenGameInstaller AppImage from Steam in Game Mode (or Big Picture). The root cause was using `ready-to-show` to detect when the main app had finished loading; that event does not fire again after the window has already been shown for the splash screen, so `onMainAppReady()` never ran and the window stayed blank. The fix switches to `webContents.once('did-finish-load', onMainAppReady)` so the callback runs reliably after the second load, and adds a dark background color to the main window and splash for a seamless transition.

## Key Modifications

- **`application/src/electron/main.ts`**
  - **Main-app ready detection:** Replaced `mainWindow!!.once('ready-to-show', onMainAppReady)` with `mainWindow!!.webContents.once('did-finish-load', onMainAppReady)` so the main app ready logic runs after the main app URL has finished loading, regardless of whether the window was already shown for splash.
  - **Window background:** Set `backgroundColor: '#1a1a1a'` on the main `BrowserWindow` in `createWindow()` to reduce black flash during load and match the app theme.
  - **Comment:** Updated JSDoc for `onMainAppReady` to reference `did-finish-load` instead of `ready-to-show`.

- **`application/public/splash.html`**
  - **Splash background:** Changed splash `body` background from `#f0f0f0` to `#1a1a1a` so the transition from splash to main app has no visible flash and matches the app’s dark theme.

- **`docs/issue-14-steam-deck-game-mode-implementation-plan.md`**
  - **New doc:** Implementation plan for Issue #14: root cause (ready-to-show not firing on second load), file changes, code details, edge cases, and testing checklist.

## Testing Notes

- **Desktop (Linux / Windows / macOS):** Launch app; splash should show, then main app should appear and be fully functional with no black screen.
- **Steam Deck Game Mode:** Add OGI as a non-Steam game (e.g. via AppImage), launch from Game Mode; expect splash then main app, no black screen, window focused and usable.
- **Big Picture:** Same as Game Mode if possible.
- **Regression:** Confirm no double registration of handlers, no duplicate windows, and that splash still updates during startup when the main window is used for splash.

## Breaking Changes

None. The change is internal to the main window lifecycle; no API, config, or data migrations are introduced.
