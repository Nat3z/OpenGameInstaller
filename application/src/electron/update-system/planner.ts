import type {
  OwnershipManifest,
  UpdateEntry,
  UpdateManifest,
} from './model.js';

export interface UpdatePlan {
  readonly reuse: readonly {
    readonly entry: UpdateEntry;
    readonly installedPath: string;
  }[];
  readonly download: readonly UpdateEntry[];
  readonly transferBytes: number;
  readonly fullDownloadBytes: number;
  readonly requestCount: number;
  readonly savingsRatio: number;
}

export interface PlannerOptions {
  readonly minimumSavingsRatio?: number;
  readonly maximumRequests?: number;
  readonly coalesceGapBytes?: number;
}

export function planUpdate(
  manifest: UpdateManifest,
  ownership: OwnershipManifest,
  options: PlannerOptions = {}
): UpdatePlan | undefined {
  const minimumSavingsRatio = options.minimumSavingsRatio ?? 0.2;
  const maximumRequests = options.maximumRequests ?? 64;
  const coalesceGapBytes = options.coalesceGapBytes ?? 64 * 1024;
  const ownedBySource = new Map(
    ownership.files.flatMap((file) =>
      file.sourcePath ? ([[file.sourcePath, file]] as const) : []
    )
  );
  const reuse: UpdatePlan['reuse'][number][] = [];
  const download: UpdateEntry[] = [];
  for (const entry of manifest.entries) {
    const owned = ownedBySource.get(entry.path);
    if (owned?.sha256 === entry.sha256 && owned.size === entry.size) {
      reuse.push({ entry, installedPath: owned.installedPath });
    } else {
      download.push(entry);
    }
  }

  const fullDownloadBytes = manifest.sources.reduce(
    (total, source) => total + source.size,
    0
  );
  const ranges = measureCoalescedRanges(download, coalesceGapBytes);
  const transferBytes = ranges.bytes;
  const requestCount = ranges.count;
  const savingsRatio =
    fullDownloadBytes === 0 ? 0 : 1 - transferBytes / fullDownloadBytes;
  if (savingsRatio < minimumSavingsRatio || requestCount > maximumRequests) {
    return undefined;
  }
  return {
    reuse,
    download,
    transferBytes,
    fullDownloadBytes,
    requestCount,
    savingsRatio,
  };
}

function measureCoalescedRanges(
  entries: readonly UpdateEntry[],
  gap: number
): { readonly count: number; readonly bytes: number } {
  let count = 0;
  let bytes = 0;
  const bySource = new Map<number, UpdateEntry[]>();
  for (const entry of entries) {
    if (entry.compressedSize === 0) continue;
    const sourceEntries = bySource.get(entry.sourceIndex) ?? [];
    sourceEntries.push(entry);
    bySource.set(entry.sourceIndex, sourceEntries);
  }
  for (const sourceEntries of bySource.values()) {
    const sorted = [...sourceEntries].sort(
      (left, right) => left.range.start - right.range.start
    );
    let start = -1;
    let end = -1;
    for (const entry of sorted) {
      if (end < 0 || entry.range.start > end + gap + 1) {
        if (start >= 0) bytes += end - start + 1;
        count += 1;
        start = entry.range.start;
      }
      end = Math.max(end, entry.range.end);
    }
    if (start >= 0) bytes += end - start + 1;
  }
  return { count, bytes };
}
