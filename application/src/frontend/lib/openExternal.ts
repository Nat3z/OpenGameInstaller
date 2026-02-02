/**
 * Opens a URL in the system default browser.
 * In Electron: uses shell.openExternal via IPC (with URL validation).
 * In browser (e.g. dev): falls back to window.open.
 */
export async function openExternal(url: string): Promise<{ success: boolean; error?: string }> {
  if (typeof url !== 'string' || url.trim() === '') {
    return { success: false, error: 'Invalid URL' };
  }
  const trimmed = url.trim();
  if (typeof window !== 'undefined' && window.electronAPI?.app?.openExternal) {
    return window.electronAPI.app.openExternal(trimmed);
  }
  try {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to open link';
    return { success: false, error: message };
  }
}
