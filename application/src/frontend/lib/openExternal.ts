const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the system default browser.
 * In Electron: uses shell.openExternal via IPC (with URL validation).
 * In browser (e.g. dev): falls back to window.open when available.
 * Only http: and https: URLs are allowed; invalid or disallowed URLs return an error.
 *
 * @param url - The URL to open (must be http or https).
 * @returns Promise resolving to `{ success: true }` or `{ success: false, error: string }`.
 */
export async function openExternal(
  url: string
): Promise<{ success: boolean; error?: string }> {
  // Flow: trim → validate scheme (http/https only) → Electron IPC (try/catch) → window.open fallback when window context is safe.
  if (typeof url !== 'string' || url.trim() === '') {
    return { success: false, error: 'Invalid URL' };
  }
  const trimmed = url.trim();
  // Only http: and https: are allowed (enforced by isAllowedExternalUrl / ALLOWED_PROTOCOLS).
  if (!isAllowedExternalUrl(trimmed)) {
    return { success: false, error: 'Invalid or disallowed URL' };
  }
  if (typeof window !== 'undefined' && window.electronAPI?.app?.openExternal) {
    try {
      return await window.electronAPI.app.openExternal(trimmed);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to open external link';
      return { success: false, error: message };
    }
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    try {
      window.open(trimmed, '_blank', 'noopener,noreferrer');
      return { success: true };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to open link';
      return { success: false, error: message };
    }
  }
  return { success: false, error: 'No way to open external links in this environment' };
}
