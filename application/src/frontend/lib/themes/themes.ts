/**
 * Theme registry: ids and display names for the Settings UI and validation.
 * Add new themes here, then add a corresponding [data-theme="id"] block in app.css.
 */

export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'synthwave', label: 'Synthwave' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const THEME_IDS: ThemeId[] = THEMES.map((t) => t.id);

const VALID_THEME_IDS = new Set<string>(THEME_IDS);

export function isValidThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && VALID_THEME_IDS.has(value);
}

export function normalizeThemeId(value: unknown): ThemeId {
  return isValidThemeId(value) ? value : 'light';
}
