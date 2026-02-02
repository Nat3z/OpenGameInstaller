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

/**
 * Type guard. Returns true if value is a string and is one of the known theme ids (from THEMES).
 * Used for validating config or user input.
 * @param value - Value to check.
 */
export function isValidThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && VALID_THEME_IDS.has(value);
}

/**
 * Coerces unknown input to a ThemeId. Returns value if it is a valid theme id, otherwise returns 'light'.
 * Safe for use with config or URL params; does not throw.
 * @param value - Value to normalize.
 */
export function normalizeThemeId(value: unknown): ThemeId {
  return isValidThemeId(value) ? value : 'light';
}
