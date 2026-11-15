// Pure path builders for new downloads. Hosts still check every path sits
// under a download root before touching disk; these only keep names safe.

/**
 * A single safe path segment: no separators, no `..`, no characters Windows
 * rejects. Falls back to `download` for empty input.
 */
export const sanitizeSegment = (segment: string | undefined | null): string => {
  if (!segment) return 'download';
  let result = segment.replace(/[/\\]+/g, '/');
  let previous: string;
  // Collapse `..` until stable, so `....` cannot become `..` again.
  do {
    previous = result;
    result = result.replace(/\.\./g, '');
  } while (result !== previous);
  const parts = result
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  const last = parts.at(-1) ?? 'download';
  return last.replace(/[\0<>:"|?*]/g, '_').slice(0, 255) || 'download';
};

/** `root/folder/` for a folder, `root/folder/file` for a file. */
export const downloadPath = (
  root: string,
  folder: string,
  file?: string
): string => {
  const base = `${root.replace(/[/\\]+$/, '')}/${sanitizeSegment(folder)}`;
  return file === undefined ? `${base}/` : `${base}/${sanitizeSegment(file)}`;
};

/** Suffixes repeated names (`a.rar`, `a_2.rar`) so files never overwrite. */
export const dedupeNames = (names: readonly string[]): string[] => {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix++) {
      const dot = name.lastIndexOf('.');
      candidate =
        dot > 0
          ? `${name.slice(0, dot)}_${suffix}${name.slice(dot)}`
          : `${name}_${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  });
};

/** The decoded last segment of a URL, as a safe file name. */
export const urlName = (link: string): string => {
  const raw = link.split('/').pop()?.split('?')[0] ?? 'download';
  try {
    return sanitizeSegment(decodeURIComponent(raw));
  } catch {
    return sanitizeSegment(raw);
  }
};

/** Folder part of a path; a path ending in a separator is already a folder. */
export const folderOf = (path: string): string =>
  /[/\\]$/.test(path)
    ? path.replace(/[/\\]+$/, '')
    : path.replace(/[/\\][^/\\]*$/, '') || '.';

export const nameOf = (path: string): string =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() ?? '';
