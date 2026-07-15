/**
 * Sanitizes a path segment (e.g. result.name or file.name) to prevent path traversal
 * and invalid characters. Returns a safe basename-like segment.
 */
export function sanitizePathSegment(
  segment: string | undefined | null
): string {
  if (segment == null || segment === '') return 'download';
  // Normalize separators to forward slash
  const normalized = segment.replace(/[/\\]+/g, '/');
  // Collapse all dot-dot traversal sequences until stable
  // e.g. "...." -> ".." -> "", "../../foo" -> "foo"
  let result = normalized;
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\.\./g, '');
  } while (result !== prev);
  // Split and reject any residual . or .. segments
  const parts = result
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..');
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
 * Validates that returned paths are contained within the download directory
 * to prevent path traversal via malicious persisted state.
 */
export function getPersistedFilePaths(
  downloadInfo: DownloadPathInfo
): string[] {
  const downloadRoot = downloadInfo.downloadPath.replace(/[/\\]+$/, '');

  if (downloadInfo.files && downloadInfo.files.length > 0) {
    const paths: string[] = [];
    for (const file of downloadInfo.files) {
      if (file.path) {
        // Validate stored path is contained within the download root
        if (isPathContained(file.path, downloadRoot)) {
          paths.push(file.path);
        } else {
          console.warn(
            'Rejected persisted file path outside download root:',
            file.path
          );
          // Fall back to sanitized name within the download root
          if (file.name) {
            paths.push(`${downloadRoot}/${sanitizePathSegment(file.name)}`);
          }
        }
      } else if (file.name) {
        paths.push(`${downloadRoot}/${sanitizePathSegment(file.name)}`);
      }
    }
    return paths;
  }

  if (isFilePath(downloadInfo.downloadPath)) {
    if (isPathContained(downloadInfo.downloadPath, downloadRoot)) {
      return [downloadInfo.downloadPath];
    }
    console.warn(
      'Rejected download path outside download root:',
      downloadInfo.downloadPath
    );
    return [];
  }

  if (downloadInfo.filename) {
    return [`${downloadRoot}/${sanitizePathSegment(downloadInfo.filename)}`];
  }

  return [];
}

/**
 * Checks whether a candidate path resolves to a location within the base directory.
 * Normalizes separators and resolves relative segments (..) for containment check.
 */
function isPathContained(candidatePath: string, baseDir: string): boolean {
  const normalizedBase = baseDir.replace(/[/\\]+/g, '/').replace(/\/+$/, '');
  const normalizedCandidate = candidatePath.replace(/[/\\]+/g, '/');

  // Resolve relative segments against an absolute or relative base
  const resolved: string[] = [];
  // If the candidate is absolute, start fresh; otherwise start with base parts
  const isAbsolute = normalizedCandidate.startsWith('/');
  if (!isAbsolute) {
    resolved.push(...normalizedBase.split('/').filter(Boolean));
  }

  for (const part of normalizedCandidate.split('/')) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '' && part !== '.') {
      resolved.push(part);
    }
  }

  const resolvedPath = resolved.join('/');
  return (
    resolvedPath === normalizedBase ||
    resolvedPath.startsWith(normalizedBase + '/')
  );
}
