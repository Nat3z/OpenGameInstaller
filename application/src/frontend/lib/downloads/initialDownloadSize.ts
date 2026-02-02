/**
 * Initial download size in bytes from a search result. Used when adding a
 * download to the store until the backend sends the real file size via
 * progress events.
 */
export function getInitialDownloadSize(
  result: { sizeInBytes?: number } | Record<string, unknown>
): number {
  return (result as { sizeInBytes?: number }).sizeInBytes ?? 0;
}
