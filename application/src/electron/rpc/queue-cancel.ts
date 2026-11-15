const cancelHandlers = new Map<string, () => unknown>();

export function registerQueueCancel(id: string, cancel: () => unknown): void {
  cancelHandlers.set(id, cancel);
}

export function removeQueueCancel(id: string): void {
  cancelHandlers.delete(id);
}

/** The queue still owns `id` (waiting, or not yet cleaned up). */
export function hasQueueCancel(id: string): boolean {
  return cancelHandlers.has(id);
}

export async function cancelQueuedDownload(id: string): Promise<void> {
  const cancel = cancelHandlers.get(id);
  if (!cancel) return;
  cancelHandlers.delete(id);
  await cancel();
}
