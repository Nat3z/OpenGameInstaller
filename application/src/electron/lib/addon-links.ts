export const DEFAULT_MARKETPLACE_URL = 'https://ogi-marketplace.nat3z.com';

const CURRENT_WEB_MARKETPLACE_SOURCES = [
  'https://gitlab.com/fat-addons/fatboy-unpack',
  'https://github.com/Nat3z/gemini-search-addon',
  'https://github.com/Nat3z/steam-integration',
  'https://gitlab.com/fat-addons/steamrip-addon',
];

const CURRENT_WEB_MARKETPLACE_SOURCE_BY_CANONICAL = new Map(
  CURRENT_WEB_MARKETPLACE_SOURCES.map((source) => [
    canonicalizeAddonSource(source),
    source,
  ])
);

export function canonicalizeAddonSource(source: string): string {
  return source
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export type ParsedAddonLink =
  | {
      kind: 'local';
      original: string;
      normalized: string;
      path: string;
      addonName: string;
    }
  | {
      kind: 'git';
      original: string;
      normalized: string;
      gitUrl: string;
      addonName: string;
    }
  | {
      kind: 'marketplace';
      original: string;
      normalized: string;
      marketplaceUrl: string;
      gitUrl: string;
      explicitRef?: string;
      addonName: string;
    };

export function getAddonNameFromGitUrl(gitUrl: string): string {
  const trimmed = gitUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const slashName = trimmed.split(/\/|\\/).pop();
  return (slashName || trimmed.split(':').pop() || trimmed).trim();
}

export function normalizeAddonLink(addonLink: string): string {
  const trimmed = addonLink.trim();
  if (!trimmed || trimmed.startsWith('local@')) {
    return trimmed;
  } else if (trimmed.startsWith('local:')) {
    return trimmed.replace(/^local:/, 'local@');
  }

  const marketplaceSource = CURRENT_WEB_MARKETPLACE_SOURCE_BY_CANONICAL.get(
    canonicalizeAddonSource(trimmed)
  );
  if (marketplaceSource) {
    return `${DEFAULT_MARKETPLACE_URL}@${marketplaceSource}`;
  }

  // Legacy addon entries were often stored as a bare repository URL. Preserve the
  // no-marketplace behavior by explicitly marking them as git-managed addons.
  if (!trimmed.includes('@')) {
    return `git@${trimmed}`;
  }

  return trimmed;
}

export function parseAddonLink(addonLink: string): ParsedAddonLink {
  const normalized = normalizeAddonLink(addonLink);

  if (normalized.startsWith('local@')) {
    const path = normalized.slice('local@'.length);
    return {
      kind: 'local',
      original: addonLink,
      normalized,
      path,
      addonName: getAddonNameFromGitUrl(path),
    };
  }

  if (normalized.startsWith('git@')) {
    const gitUrl = normalized.slice('git@'.length);

    // A raw SSH repository URL (git@host:owner/repo) is a git-managed addon,
    // not a marketplace association. Explicit git@ associations have a full URL
    // after the prefix (for example git@https://host/owner/repo) or another SSH
    // URL (git@git@host:owner/repo).
    // Raw SSH URLs (git@host:owner/repo) already start with git@, so treat the
    // full string as both the normalized link and the clone URL. Prefixing again
    // would produce corrupt git@git@host:owner/repo entries in config.
    if (
      !gitUrl.startsWith('http://') &&
      !gitUrl.startsWith('https://') &&
      !gitUrl.startsWith('ssh://') &&
      !gitUrl.startsWith('git@') &&
      /^git@[^/]+:.+/.test(normalized)
    ) {
      return {
        kind: 'git',
        original: addonLink,
        normalized,
        gitUrl: normalized,
        addonName: getAddonNameFromGitUrl(normalized),
      };
    }

    return {
      kind: 'git',
      original: addonLink,
      normalized,
      gitUrl,
      addonName: getAddonNameFromGitUrl(gitUrl),
    };
  }

  const separatorIndex = normalized.indexOf('@');
  if (separatorIndex === -1) {
    return {
      kind: 'git',
      original: addonLink,
      normalized: `git@${normalized}`,
      gitUrl: normalized,
      addonName: getAddonNameFromGitUrl(normalized),
    };
  }

  const marketplaceUrl = normalized.slice(0, separatorIndex);
  const gitUrlWithRef = normalized.slice(separatorIndex + 1);
  const refSeparatorIndex = gitUrlWithRef.lastIndexOf(':');
  // The override separator must appear after the repository path begins. This excludes
  // URL schemes, ports, and the host separator in git@host:owner/repository.
  const schemeSeparatorIndex = gitUrlWithRef.indexOf('://');
  const repositoryPathIndex =
    schemeSeparatorIndex === -1
      ? Math.min(
          ...[gitUrlWithRef.indexOf('/'), gitUrlWithRef.indexOf('\\')].filter(
            (index) => index !== -1
          )
        )
      : gitUrlWithRef.indexOf('/', schemeSeparatorIndex + 3);
  const sshHostSeparatorIndex = /^git@/.test(gitUrlWithRef)
    ? gitUrlWithRef.indexOf(':')
    : -1;
  const hasExplicitRef =
    refSeparatorIndex > Math.max(repositoryPathIndex, sshHostSeparatorIndex) &&
    refSeparatorIndex < gitUrlWithRef.length - 1;
  const gitUrl = hasExplicitRef
    ? gitUrlWithRef.slice(0, refSeparatorIndex)
    : gitUrlWithRef;
  const explicitRef = hasExplicitRef
    ? gitUrlWithRef.slice(refSeparatorIndex + 1)
    : undefined;
  return {
    kind: 'marketplace',
    original: addonLink,
    normalized,
    marketplaceUrl,
    gitUrl,
    explicitRef,
    addonName: getAddonNameFromGitUrl(gitUrl),
  };
}
