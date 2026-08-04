import { electronIpcMain } from '@/electron/rpc/handlers.js';

export type DownloadHandshakeStatus =
  | 'queued'
  | 'downloading'
  | 'error'
  | 'completed'
  | 'seeding';

export interface DownloadHandshakeResult {
  id: string;
  status: DownloadHandshakeStatus;
  queuePosition?: number;
  error?: string;
}

interface PendingHandshake {
  resolve: (result: DownloadHandshakeResult) => void;
  settled: boolean;
}

interface ReplayEvent {
  channel: string;
  data: unknown;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;

const lastKnownState = new Map<string, DownloadHandshakeResult>();
const pendingHandshakes = new Map<string, PendingHandshake>();
const settledHandshakes = new Set<string>();
const pendingReplay = new Map<string, ReplayEvent[]>();
let handshakeHandlersRegistered = false;

function isReadyState(state: DownloadHandshakeResult): boolean {
  if (
    state.status === 'error' ||
    state.status === 'completed' ||
    state.status === 'seeding'
  ) {
    return true;
  }
  if (state.status === 'downloading') {
    return true;
  }
  if (state.status === 'queued' && state.queuePosition !== undefined) {
    return true;
  }
  return false;
}

function settleHandshake(id: string, state: DownloadHandshakeResult) {
  const pending = pendingHandshakes.get(id);
  if (!pending || pending.settled) {
    return;
  }
  pending.settled = true;
  settledHandshakes.add(id);
  pending.resolve(state);
}

export function registerDownloadHandshake(id: string) {
  const initial: DownloadHandshakeResult = { id, status: 'queued' };
  lastKnownState.set(id, initial);
}

export function updateDownloadHandshake(
  update: DownloadHandshakeResult,
  terminalEvent?: ReplayEvent
) {
  const current = lastKnownState.get(update.id);
  const merged: DownloadHandshakeResult = {
    id: update.id,
    status: update.status ?? current?.status ?? 'queued',
    queuePosition: update.queuePosition ?? current?.queuePosition,
    error: update.error ?? current?.error,
  };
  lastKnownState.set(update.id, merged);

  if (isReadyState(merged)) {
    settleHandshake(update.id, merged);
  }

  if (!terminalEvent) {
    return;
  }

  if (settledHandshakes.has(update.id)) {
    const events = pendingReplay.get(update.id) ?? [];
    events.push(terminalEvent);
    pendingReplay.set(update.id, events);
  }
}

export function waitForDownloadHandshake(
  id: string,
  timeoutMs = HANDSHAKE_TIMEOUT_MS
): Promise<DownloadHandshakeResult> {
  const existing = lastKnownState.get(id);
  if (existing && isReadyState(existing)) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve) => {
    pendingHandshakes.set(id, {
      settled: false,
      resolve: (result) => {
        pendingHandshakes.delete(id);
        resolve(result);
      },
    });

    setTimeout(() => {
      const pending = pendingHandshakes.get(id);
      if (!pending || pending.settled) {
        return;
      }
      pending.settled = true;
      settledHandshakes.add(id);
      pendingHandshakes.delete(id);
      resolve(
        lastKnownState.get(id) ?? {
          id,
          status: 'error',
          error: 'Download handshake timed out',
        }
      );
    }, timeoutMs);
  });
}

export function consumeDownloadReplayEvents(id: string): ReplayEvent[] {
  const events = pendingReplay.get(id) ?? [];
  pendingReplay.delete(id);
  return events;
}

export function getDownloadHandshakeState(
  id: string
): DownloadHandshakeResult | undefined {
  return lastKnownState.get(id);
}

export function clearDownloadHandshake(id: string) {
  lastKnownState.delete(id);
  pendingHandshakes.delete(id);
  settledHandshakes.delete(id);
  // Don't clear pendingReplay here — let consumeDownloadReplayEvents
  // own the deletion so the renderer can still consume buffered events
  // after clearDownloadHandshake runs on the main process.
}

export function registerDownloadHandshakeHandlers() {
  if (handshakeHandlersRegistered) {
    return;
  }
  handshakeHandlersRegistered = true;

  electronIpcMain.handle('download:consume-replay-events', (_, id: string) => {
    return consumeDownloadReplayEvents(id);
  });

  electronIpcMain.handle('download:get-handshake-state', (_, id: string) => {
    return getDownloadHandshakeState(id);
  });
}
