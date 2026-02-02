/**
 * Applies the given theme by setting data-theme on document.documentElement. Does not persist;
 * persistence is handled elsewhere (e.g. ClientOptionsView saving to general.json).
 * @param themeId - Theme id (e.g. 'light', 'dark', 'synthwave'). Callers should pass a valid theme id; no validation inside.
 */
export function applyTheme(themeId: string): void {
  document.documentElement.setAttribute('data-theme', themeId);
}
