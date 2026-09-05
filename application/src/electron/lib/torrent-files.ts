import { open, stat } from 'node:fs/promises';

export interface TorrentFileExpectation {
  path: string;
  length: number;
}

interface TorrentFileReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  probe?: (file: TorrentFileExpectation) => Promise<void>;
}

async function probeTorrentFile(file: TorrentFileExpectation): Promise<void> {
  const fileStat = await stat(file.path);
  if (fileStat.size !== file.length) {
    throw new Error(
      `Torrent file has size ${fileStat.size}, expected ${file.length}: ${file.path}`
    );
  }

  const handle = await open(file.path, 'r');
  await handle.close();
}

/** Wait until WebTorrent's completed files can be safely reopened by setup/seeding. */
export async function waitForTorrentFiles(
  files: readonly TorrentFileExpectation[],
  options: TorrentFileReadinessOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const probe = options.probe ?? probeTorrentFile;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  do {
    try {
      await Promise.all(files.map(probe));
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, intervalMs)
      );
    }
  } while (Date.now() <= deadline);

  throw lastError instanceof Error
    ? lastError
    : new Error('Torrent files did not become ready');
}
