/**
 * Sanitizes a path segment (e.g. result.name or file.name) to prevent path traversal
 * and invalid characters. Returns a safe basename-like segment.
 */
export function sanitizePathSegment(segment: string | undefined | null): string {
  if (segment == null || segment === '') return 'download';
  const normalized = segment.replace(/[/\\]+/g, '/').replace(/\.\./g, '');
  const parts = normalized.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? 'download';
  return last.replace(/[\0<>:"|?*]/g, '_').substring(0, 255) || 'download';
}

/**
 * Builds a consistent download path under baseDir with sanitized folder and optional file segments.
 * Returns a folder path with trailing slash when fileName is omitted; a file path otherwise.
 */
export function safeDownloadPath(
  baseDir: string,
  folderName: string,
  fileName?: string
): string {
  const base = baseDir.replace(/[/\\]+$/, '');
  const folder = sanitizePathSegment(folderName);
  if (fileName === undefined) {
    return `${base}/${folder}/`;
  }
  const file = sanitizePathSegment(fileName);
  return `${base}/${folder}/${file}`;
}

/** Ensures unique basenames so multi-file torrents do not overwrite each other. */
export function dedupeFileNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const outputs = new Set<string>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0 && !outputs.has(name)) {
      outputs.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    let candidate: string;
    let suffix = count + 1;
    while (true) {
      if (dot > 0) {
        candidate = `${name.slice(0, dot)}_${suffix}${name.slice(dot)}`;
      } else {
        candidate = `${name}_${suffix}`;
      }
      if (!outputs.has(candidate)) {
        outputs.add(candidate);
        break;
      }
      suffix++;
    }
    return candidate;
  });
}

export function urlBasename(link: string): string {
  const raw = link.split('/').pop()?.split('?')[0] ?? 'download';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return sanitizePathSegment(decoded);
}

export type DownloadFileEntry = {
  name: string;
  path?: string;
  downloadURL?: string;
  headers?: Record<string, string>;
};

export type DownloadPathInfo = {
  downloadPath: string;
  files?: DownloadFileEntry[];
  filename?: string;
};

function isFilePath(downloadPath: string): boolean {
  return (
    typeof downloadPath === 'string' &&
    !downloadPath.endsWith('/') &&
    !downloadPath.endsWith('\\')
  );
}

/**
 * Resolves exact on-disk file paths for cleanup/resume from persisted download state.
 * Prefers stored per-file paths over reconstructing from display names.
 */
export function getPersistedFilePaths(downloadInfo: DownloadPathInfo): string[] {
  if (downloadInfo.files && downloadInfo.files.length > 0) {
    const paths: string[] = [];
    const folder = downloadInfo.downloadPath.replace(/[/\\]+$/, '');
    for (const file of downloadInfo.files) {
      if (file.path) {
        paths.push(file.path);
      } else if (file.name) {
        paths.push(`${folder}/${sanitizePathSegment(file.name)}`);
      }
    }
    return paths;
  }

  if (isFilePath(downloadInfo.downloadPath)) {
    return [downloadInfo.downloadPath];
  }

  if (downloadInfo.filename) {
    const folder = downloadInfo.downloadPath.replace(/[/\\]+$/, '');
    return [`${folder}/${sanitizePathSegment(downloadInfo.filename)}`];
  }

  return [];
}
