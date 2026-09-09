import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * Sanitizes a path segment (e.g. a file name) to prevent path traversal and
 * invalid characters. Returns a safe basename-like segment.
 */
export function sanitizePathSegment(
  segment: string | undefined | null
): string {
  if (segment == null || segment === '') return 'download';
  const normalized = segment.replace(/[/\\]+/g, '/');
  // Collapse dot-dot sequences until stable: "...." -> ".." -> "".
  let result = normalized;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\.\./g, '');
  } while (result !== previous);
  const parts = result
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  const last = parts[parts.length - 1] ?? 'download';
  return last.replace(/[\0<>:"|?*]/g, '_').substring(0, 255) || 'download';
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

const isFilePath = (downloadPath: string): boolean =>
  typeof downloadPath === 'string' &&
  !downloadPath.endsWith('/') &&
  !downloadPath.endsWith('\\');

/**
 * Resolves the exact on-disk paths a persisted download wrote. Prefers stored
 * per-file paths over reconstructing from display names, and rejects anything
 * that escapes the download root so malicious persisted state cannot delete
 * unrelated files.
 */
export function getPersistedFilePaths(
  downloadInfo: DownloadPathInfo
): string[] {
  const downloadRoot = downloadInfo.downloadPath.replace(/[/\\]+$/, '');

  if (downloadInfo.files && downloadInfo.files.length > 0) {
    const paths: string[] = [];
    for (const file of downloadInfo.files) {
      if (file.path) {
        if (isPathContained(file.path, downloadRoot)) {
          paths.push(file.path);
        } else {
          logger.sync.warn(
            'Rejected persisted file path outside download root:',
            file.path
          );
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
    logger.sync.warn(
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

/** Resolves `..` segments and checks the result stays inside `baseDir`. */
function isPathContained(candidatePath: string, baseDir: string): boolean {
  const normalizedBase = baseDir.replace(/[/\\]+/g, '/').replace(/\/+$/, '');
  const normalizedCandidate = candidatePath.replace(/[/\\]+/g, '/');

  const resolved: string[] = [];
  if (!normalizedCandidate.startsWith('/')) {
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
    resolvedPath.startsWith(`${normalizedBase}/`)
  );
}
