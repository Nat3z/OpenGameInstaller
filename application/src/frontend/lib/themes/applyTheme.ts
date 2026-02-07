/**
 * Applies the given theme by setting data-theme on document.documentElement. Does not persist;
 * persistence is handled elsewhere (e.g. ClientOptionsView saving to general.json).
 * If themeId is 'system', detects OS preference and applies 'light' or 'dark' accordingly.
 * @param themeId - Theme id (e.g. 'light', 'dark', 'synthwave', 'system'). Callers should pass a valid theme id; no validation inside.
 */
export function applyTheme(themeId: string): void {
  let effectiveTheme = themeId;
  
  if (themeId === 'system') {
    // Detect system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      effectiveTheme = 'dark';
    } else {
      effectiveTheme = 'light';
    }
  }
  
  document.documentElement.setAttribute('data-theme', effectiveTheme);
}

/**
 * Sets up a listener for system theme changes when using 'system' theme.
 * Should be called once during app initialization.
 * @param getCurrentThemePreference - Function that returns the current theme preference from config
 */
export function setupSystemThemeListener(getCurrentThemePreference: () => string): void {
  if (!window.matchMedia) return;
  
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  
  const handleChange = () => {
    const currentPref = getCurrentThemePreference();
    if (currentPref === 'system') {
      applyTheme('system');
    }
  };
  
  // Modern browsers
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handleChange);
  } else if (mediaQuery.addListener) {
    // Legacy browsers
    mediaQuery.addListener(handleChange);
  }
}
