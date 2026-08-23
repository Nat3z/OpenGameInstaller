import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join, parse, resolve, sep } from 'path';

/** Realpath + case-normalize (win32) so symlinks and drive casing can't bypass guards. */
export const normalizeDeletePath = (value: string): string => {
  let normalized: string;
  try {
    normalized = realpathSync(value);
  } catch {
    normalized = resolve(value);
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const withTrailingSep = (base: string): string =>
  base.endsWith(sep) || base === '' ? base : base + sep;

/** Containment match that also handles filesystem roots (`/`, `C:\`). */
const containsOrEquals = (base: string, target: string): boolean => {
  const normalizedBase = base.replace(/[\\/]$/, '');
  return (
    target === normalizedBase ||
    target === base ||
    target.startsWith(withTrailingSep(normalizedBase))
  );
};

/**
 * Targets we will never recursively delete when removing a game. Exact-match
 * entries protect the paths themselves; containment entries protect whole
 * subtrees (used only for OGI's metadata directories, never for home or the
 * data dir, so game installs under either stay deletable).
 */
export type DeleteGuardRoots = {
  /** Exact-match only. */
  readonly exact: string[];
  /** Exact match plus everything beneath them. */
  readonly subtrees: string[];
};

/**
 * Whether `target` is protected from deletion: an exact protected path, or a
 * path inside one of the protected subtrees.
 */
export const isProtectedDeletePath = (
  target: string,
  roots: DeleteGuardRoots
): boolean => {
  const resolved = normalizeDeletePath(target);
  const matches = (paths: string[], containment: boolean): boolean =>
    paths.some((path) => {
      const base = normalizeDeletePath(path);
      if (!containment) return resolved === base;
      return containsOrEquals(base, resolved);
    });
  return matches(roots.exact, false) || matches(roots.subtrees, true);
};

/** Refuse deletion when the directory overlaps another game's install directory. */
export const sharesDirectoryWithOtherGames = (
  appID: number,
  target: string,
  otherGames: ReadonlyArray<{ appID: number; cwd?: string }>
): boolean => {
  const resolvedTarget = normalizeDeletePath(target);
  return otherGames.some((other) => {
    if (other.appID === appID || !other.cwd) return false;
    const otherCwd = normalizeDeletePath(other.cwd);
    return (
      resolvedTarget === otherCwd ||
      resolvedTarget.startsWith(withTrailingSep(otherCwd)) ||
      otherCwd.startsWith(withTrailingSep(resolvedTarget))
    );
  });
};

/** App-owned directories that must never be wiped by a game removal. */
export const appMetadataSubtrees = (dataDir: string): string[] => [
  join(dataDir, 'config'),
  join(dataDir, 'internals'),
  join(dataDir, 'addons'),
  join(dataDir, 'library'),
];

/**
 * System directories no game install should ever live in. Kept separate from
 * the filesystem root so legitimate install locations on the same drive stay
 * deletable.
 */
export const systemSubtrees = (): string[] => {
  if (process.platform === 'win32') {
    return [
      process.env.SystemRoot ?? 'C:\\Windows',
      process.env.ProgramFiles ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    ];
  }
  return [
    '/etc',
    '/usr',
    '/var',
    '/boot',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/proc',
    '/sys',
    '/dev',
  ];
};

export const filesystemRoot = (): string => parse(homedir()).root;
