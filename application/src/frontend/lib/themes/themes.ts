/**
 * Theme registry: ids and display names for the Settings UI. Add new themes here and a matching [data-theme='id'] block in app.css.
 */
export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'synthwave', label: 'Synthwave' },
] as const;

/** Union of theme id strings from THEMES. */
export type ThemeId = (typeof THEMES)[number]['id'];

/** Array of theme ids for validation/iteration. */
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
