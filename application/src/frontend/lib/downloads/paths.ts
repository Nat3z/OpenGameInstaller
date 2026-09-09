// Path builders for new downloads. Resolving the files a persisted download
// wrote lives in the main process (`lib/download-paths.ts`).
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
