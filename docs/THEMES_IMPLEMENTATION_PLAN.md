# Themes Implementation Plan (Dark Mode, Synthwave, etc.)

This document outlines a detailed plan for adding a theming system to OpenGameInstaller, allowing users to choose themes such as light (default), dark, synthwave, and future options.

---

## 1. Current State Summary

- **Styling**: Tailwind v4 with `@theme` in `application/src/frontend/app.css` defining CSS variables:
  - `--color-accent`, `--color-accent-dark`, `--color-accent-light`, `--color-accent-lighter`
  - `--color-accent-text-color`, `--color-background-color`
- **Usage**: Components use semantic classes (`text-accent-dark`, `bg-background-color`, `bg-accent-lighter`, etc.) and some raw `var(--color-*)` in `<style>` blocks.
- **Persistence**: App options live in `./config/option/{category}.json` (e.g. `general.json`). ClientOptionsView defines options and reads/writes via `window.electronAPI.fs`. No app-level “preferences” file exists yet; theme can be stored in `general.json` or a dedicated `./internals/preferences.json`.
- **Entry**: `index.html` → `main.ts` (imports `app.css`, mounts `App.svelte`). Theme must be applied before first paint to avoid flash.

---

## 2. Architecture Overview

1. **Theme definition**: Each theme is a set of values for the existing CSS variables. Default theme stays in `@theme`; other themes override variables when a `data-theme="..."` attribute is set on `<html>`.
2. **Persistence**: Store selected theme id (e.g. `"light"` | `"dark"` | `"synthwave"`) in `./config/option/general.json` under key `theme`, so it lives with other General options and reuses existing load/save in ClientOptionsView.
3. **Apply on load**: Use a **synchronous** IPC from renderer (invoked from an inline script in `index.html` before the Svelte app mounts) so the main process reads the theme from disk and returns it; the inline script sets `document.documentElement.setAttribute('data-theme', theme)` immediately.
4. **Apply on change**: When the user changes theme in Settings, write to `general.json` and set `document.documentElement.setAttribute('data-theme', newTheme)` so the UI updates without restart.

---

## 3. Files to Create

| File | Purpose |
|------|--------|
| `application/src/frontend/lib/themes/themes.ts` | Theme registry: theme ids, display names, and CSS variable sets (or file paths). Used by UI and by main process for initial theme read. |
| `application/src/frontend/lib/themes/applyTheme.ts` | Small helper: `applyTheme(themeId: string)` sets `document.documentElement.dataset.theme = themeId`. Optionally persists via existing config write. |
| `application/src/frontend/app-themes.css` (optional) | If theme definitions grow large, a separate CSS file that only contains `[data-theme="dark"] { ... }` etc. Imported from `app.css`. |

**Recommendation**: Keep theme definitions in CSS (see “Files to modify”) and in `themes.ts` only metadata (id, label). No separate `app-themes.css` unless the number of themes/variables grows a lot.

---

## 4. Files to Modify

### 4.1 `application/index.html`

- **Add an inline script** (before the `type="module"` script) that:
  - Calls `window.electronAPI.getInitialTheme()` (sync IPC, see below).
  - If a string is returned, sets `document.documentElement.setAttribute('data-theme', theme)`.
  - Does not depend on Svelte; runs as soon as the document is parsed so theme is set before first paint.

```html
<!-- Add before the main script -->
<script>
  (function () {
    if (window.electronAPI && typeof window.electronAPI.getInitialTheme === 'function') {
      try {
        var t = window.electronAPI.getInitialTheme();
        if (t && typeof t === 'string') document.documentElement.setAttribute('data-theme', t);
      } catch (e) {}
    }
  })();
</script>
<script type="module" src="/src/frontend/main.ts"></script>
```

### 4.2 `application/src/frontend/app.css`

- **Keep the current `@theme { ... }` block** as the default (light) theme — i.e. these variables apply when there is no `data-theme` or when `data-theme="light"`.
- **Add theme overrides** after `@theme` and after keyframes, using attribute selectors:
  - `[data-theme="light"]` — can be explicit or omit (same as default).
  - `[data-theme="dark"]` — set dark background, light text, adjusted accent colors.
  - `[data-theme="synthwave"]` — synthwave palette (e.g. dark bg, neon accents).

Define only the variables that change per theme (e.g. `--color-background-color`, `--color-accent`, `--color-accent-dark`, etc.). Use the same variable names so existing components need no change.

Example structure:

```css
/* After @theme and keyframes */

[data-theme="dark"] {
  --color-background-color: #1a1a2e;
  --color-accent: #4a9eff;
  --color-accent-dark: #2563eb;
  --color-accent-light: #93c5fd;
  --color-accent-lighter: #1e293b;
  --color-accent-text-color: #f1f5f9;
}

[data-theme="synthwave"] {
  --color-background-color: #2b213a;
  --color-accent: #f92aad;
  --color-accent-dark: #e91e96;
  --color-accent-light: #ff7edb;
  --color-accent-lighter: #36224a;
  --color-accent-text-color: #f0e6ef;
}
```

- **Global elements** that use hardcoded colors (e.g. in `application/public/global.css` or in `app.css` for `body`/inputs) should be updated to use the same CSS variables where it makes sense (e.g. `body { background-color: var(--color-background-color); color: var(--color-accent-text-color); }`), so they respond to theme.

### 4.3 `application/src/electron/handlers/handler.fs.ts` (or new handler)

- **Option A – Reuse fs and do read in renderer**: No main change; renderer calls existing `window.electronAPI.fs.read('./config/option/general.json')` when needed. Problem: that cannot run synchronously in an inline script before the app mounts without blocking. So for **no flash**, we need a sync IPC.

- **Option B – Add sync IPC for initial theme (recommended)**:
  - In **main process** (e.g. in `handler.fs.ts` or `main.ts`): register `ipcMain.on('get-initial-theme', (event) => { ... })`. In the handler, read `join(__dirname, 'config/option/general.json')` (or a dedicated `internals/preferences.json`), parse JSON, get `theme` (or `preferences.theme`), and set `event.returnValue = theme ?? 'light'`.
  - Ensure `config/option` (and `internals` if used) exist or handle missing file (return `'light'`).
  - **Preload**: Expose `getInitialTheme: () => ipcRenderer.sendSync('get-initial-theme')`.

So:

- **handler.fs.ts** (or a small new file `handler.preferences.ts`): Add sync listener that reads theme from `general.json` and returns it.
- **preload.mts**: Add `getInitialTheme: () => ipcRenderer.sendSync('get-initial-theme')` under `electronAPI`.

### 4.4 `application/src/electron/preload.mts`

- Add to the object exposed via `contextBridge`:
  - `getInitialTheme: wrap(() => ipcRenderer.sendSync('get-initial-theme'))`
- Ensure the channel name matches what main process uses.

### 4.5 `application/src/frontend/views/ClientOptionsView.svelte`

- **General category options**: Add a new option, e.g.:
  - `theme`: type `'string'`, `choice: ['light', 'dark', 'synthwave']`, `defaultValue: 'light'`, displayName `"Theme"`, description `"Appearance theme (e.g. light, dark, synthwave)"`.
- **Rendering**: Use the same pattern as existing `choice` options (dropdown/select) so the user picks a theme. On change, call `updateConfig()` (which already writes `./config/option/general.json`) and then apply the theme to the document:
  - `document.documentElement.setAttribute('data-theme', newValue)`.
- **Initial value**: `getStoredOrDefaultValue('theme')` will return stored or `'light'`. You can optionally run `applyTheme(getStoredOrDefaultValue('theme'))` on mount so the Settings page reflects the current theme even if it was changed elsewhere (e.g. future quick-toggle).

### 4.6 `application/src/frontend/lib/themes/applyTheme.ts` (new)

- Export `applyTheme(themeId: string): void` that sets `document.documentElement.setAttribute('data-theme', themeId)`.
- Optionally: call a small helper that writes `theme` to `general.json` via existing fs API so that “apply” and “save” are in one place when changing from ClientOptionsView. Alternatively, rely entirely on ClientOptionsView’s `updateConfig()` for persistence and use `applyTheme` only for the DOM update.

### 4.7 `application/src/frontend/lib/themes/themes.ts` (new)

- Export a list of theme descriptors, e.g. `{ id: string; label: string }[]` for use in ClientOptionsView dropdown (and any future theme picker).
- Keep a single source of truth for theme ids so the same list is used for:
  - `getInitialTheme()` default/validation (main can allow any string or restrict to known ids),
  - ClientOptionsView `choice` array,
  - Any future UI that shows theme names.

### 4.8 `application/public/global.css`

- Replace hardcoded `color: #333`, `background-color: #f1f5f9`, etc., with variables where appropriate (e.g. `color: var(--color-accent-text-color)`; `background-color: var(--color-background-color)` or a dedicated input-bg variable) so global styles respect the active theme. If some styles are only used in one context, prefer variables for consistency.

### 4.9 TypeScript / global types

- If you expose `getInitialTheme` on `window.electronAPI`, add its type in `application/src/frontend/global.d.ts` (or wherever `electronAPI` is typed) so that the inline script and the rest of the app type-check correctly.

---

## 5. Specific Changes Checklist

1. **Main process**
   - Add `ipcMain.on('get-initial-theme', (event) => { ... })` that reads `config/option/general.json` (or `internals/preferences.json`), returns `theme` or `'light'`. Use `join(__dirname, 'config/option/general.json')` and handle missing file / invalid JSON.

2. **Preload**
   - Expose `getInitialTheme: () => ipcRenderer.sendSync('get-initial-theme')`.

3. **index.html**
   - Inline script that calls `getInitialTheme()` and sets `document.documentElement.setAttribute('data-theme', theme)` before the module script runs.

4. **app.css**
   - Add `[data-theme="dark"]` and `[data-theme="synthwave"]` (and optionally `[data-theme="light"]`) with full variable overrides. Ensure default `@theme` remains the light theme.

5. **ClientOptionsView**
   - Add `theme` to General options with `type: 'string'`, `choice: ['light', 'dark', 'synthwave']`, `defaultValue: 'light'`.
   - On option change (when saving), call `document.documentElement.setAttribute('data-theme', newTheme)` so the app updates immediately.

6. **themes.ts**
   - Export `THEMES = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'synthwave', label: 'Synthwave' }]` (and use this in ClientOptionsView for labels if you want to avoid duplicating strings).

7. **applyTheme.ts**
   - Implement `applyTheme(themeId)` and use it from ClientOptionsView when the user changes the theme, and optionally on app init in `App.svelte` if you need to re-sync after load.

8. **global.css**
   - Switch body/input/label colors to CSS variables so they follow the theme.

9. **global.d.ts**
   - Add `getInitialTheme?: () => string` to the `electronAPI` interface.

---

## 6. How It Fits Into Existing Code

- **Config flow**: Theme is just another option in the existing General config. ClientOptionsView already loads/saves `./config/option/general.json`; adding `theme` requires no new persistence layer. The only new piece is reading that file **synchronously** in the main process at load time for the inline script.
- **Styling**: All existing components already use semantic Tailwind classes or `var(--color-*)`. No component needs to change except where global styles (e.g. `global.css`) use literals; those become variables.
- **State**: No need for a Svelte store or runes for theme if the source of truth is the DOM (`data-theme`) plus `general.json`. If you later add a quick theme toggle in the header, you can read `document.documentElement.getAttribute('data-theme')` or maintain a small reactive state that stays in sync with the DOM and config.
- **OOBE / first run**: If `general.json` does not exist yet, the main process returns `'light'`; after the user saves any General options (including theme), the file is created with `theme` in it.

---

## 7. Edge Cases and Considerations

1. **Invalid or missing theme id**
   - If the stored value is typo or an old removed theme, either fall back to `'light'` in the main process and in `applyTheme`, or validate against `THEMES.map(t => t.id)` and default to `'light'`.

2. **Missing general.json**
   - Main process: if file does not exist or JSON parse fails, return `'light'`. Do not create the file in the sync handler; let ClientOptionsView create it when the user saves options.

3. **Flash of wrong theme (FOUC)**
   - The inline script in `index.html` must run before any painted content. Keep it small and synchronous. Do not load Svelte or other app code in that script.

4. **Splash / loading screen**
   - `application/public/splash.html` has its own inline styles. It is shown before the main window. Options: (a) leave splash theme-neutral (current grays), (b) pass theme from main to splash and inject a small style block, or (c) defer splash theming to a later iteration. Recommendation: (a) for minimal scope.

5. **High contrast / accessibility**
   - Ensure dark and synthwave themes keep sufficient contrast (e.g. WCAG AA). Consider adding a “high contrast” variant later if needed.

6. **Status colors (red, yellow, green)**
   - Many components use Tailwind’s `red-500`, `yellow-500`, `green-500` for status (errors, warnings, success). These are intentionally not semantic theme colors. Options: (a) leave as-is so status meaning is consistent across themes, (b) introduce `--color-status-error`, `--color-status-warning`, `--color-status-success` and override per theme. Recommendation: (a) unless you want status colors to match theme (e.g. softer in dark mode).

7. **New themes in future**
   - Add a new entry in `themes.ts`, new `[data-theme="newid"]` block in `app.css`, and add the id to the General `theme` choice array in ClientOptionsView. No change to main/preload/index.html once the pipeline is in place.

8. **Electron security**
   - Sync IPC is acceptable for a single lightweight read at startup. Do not expose broader fs access; keep the handler limited to reading the one config file and returning the theme string.

9. **Tests**
   - If you add unit tests, consider testing: (a) `applyTheme` sets `data-theme` on `document.documentElement`, (b) main process returns `'light'` when file is missing or invalid, (c) ClientOptionsView option save updates config and DOM.

---

## 8. Optional Enhancements (Later)

- **System theme**: Detect OS dark/light preference (e.g. `prefers-color-scheme`) and offer a “System” option that switches between light/dark automatically; store `theme: 'system'` and resolve to `'light'` or `'dark'` in the inline script and when applying.
- **Quick toggle**: A header or footer control that cycles light/dark without opening Settings.
- **Per-window theme**: Usually not needed; one theme for the app is enough.
- **Custom themes**: Allow power users to supply a JSON or CSS file that defines variable overrides; load and apply dynamically (advanced).

---

## 9. Summary Table

| Area            | Action |
|-----------------|--------|
| **Create**      | `lib/themes/themes.ts`, `lib/themes/applyTheme.ts` |
| **Modify**      | `index.html`, `app.css`, `global.css`, `ClientOptionsView.svelte`, preload, main (or handler.fs), `global.d.ts` |
| **Persistence** | `./config/option/general.json` key `theme` |
| **Apply on load** | Sync IPC `get-initial-theme` + inline script in index.html |
| **Apply on change** | `document.documentElement.setAttribute('data-theme', id)` + existing `updateConfig()` in ClientOptionsView |

This plan keeps the existing config and styling architecture, reuses General options for theme, and adds a minimal sync path for no-flash initial theme application.
