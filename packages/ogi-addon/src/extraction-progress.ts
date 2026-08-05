export type UnrarType = 'unrar-free' | 'unrar-nonfree' | 'unknown';

export const isSupportedArchivePath = (
  platform: NodeJS.Platform,
  filePath: string
): boolean => {
  if (platform === 'win32') return true;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith('.zip') || lowerPath.endsWith('.rar');
};

const safeTotal = (values: Iterable<string>): number | undefined => {
  let total = 0;
  let found = false;
  for (const value of values) {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    found = true;
    total += size;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return found ? total : undefined;
};

export const detectUnrarTypeFromOutput = (output: string): UnrarType => {
  if (output.includes('unrar-free')) return 'unrar-free';
  return output.includes('unrar-nonfree') || /\bUNRAR\b/.test(output)
    ? 'unrar-nonfree'
    : 'unknown';
};

export const parseSevenZipTotal = (output: string): number | undefined =>
  safeTotal(
    [...output.matchAll(/^Size = (\d+)\s*$/gm)].map((match) => match[1])
  );

export const parseZipInfoTotal = (output: string): number | undefined => {
  const match = output.match(/\d+ files?,\s+(\d+) bytes uncompressed(?:,|\s)/);
  return match ? safeTotal([match[1]]) : undefined;
};

export const parseUnrarFreeTotal = (output: string): number | undefined => {
  const totals = [...output.matchAll(/^\s*\d+\s+(\d+)\s*$/gm)];
  const total = totals.at(-1)?.[1];
  return total ? safeTotal([total]) : undefined;
};

export const parseUnrarNonFreeTotal = (output: string): number | undefined =>
  safeTotal(
    [...output.matchAll(/^\s*Size:\s*(\d+)\s*$/gm)].map((match) => match[1])
  );
