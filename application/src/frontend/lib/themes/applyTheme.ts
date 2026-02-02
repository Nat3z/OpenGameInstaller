/**
 * Applies the given theme by setting data-theme on the document root.
 * Does not persist; ClientOptionsView handles saving to general.json.
 */

export function applyTheme(themeId: string): void {
  document.documentElement.setAttribute('data-theme', themeId);
}
