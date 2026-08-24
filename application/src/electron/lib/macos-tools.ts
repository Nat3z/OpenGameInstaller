import { existsSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const resolveFromPath = (executable: string): string | undefined => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

export const resolveSupportedHomebrew = (): string | undefined =>
  ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync);

export const resolveHomebrew = (): string | undefined =>
  resolveSupportedHomebrew() ?? resolveFromPath('brew');

const getHomebrewPrefix = (brewPath: string | undefined): string | undefined =>
  brewPath ? dirname(dirname(brewPath)) : undefined;

export const resolveBun = (
  brewPath: string | undefined
): string | undefined => {
  const brewPrefix = getHomebrewPrefix(brewPath);
  const candidates = [
    brewPrefix ? join(brewPrefix, 'bin', 'bun') : undefined,
    join(os.homedir(), '.bun', 'bin', 'bun'),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate))
    ) ?? resolveFromPath('bun')
  );
};

export const resolveGit = (
  brewPath: string | undefined
): string | undefined => {
  const brewPrefix = getHomebrewPrefix(brewPath);
  const candidates = [
    '/usr/bin/git',
    brewPrefix ? join(brewPrefix, 'bin', 'git') : undefined,
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate))
    ) ?? resolveFromPath('git')
  );
};

export const getBunProvenance = (
  bunPath: string | undefined
): 'homebrew' | 'direct' | undefined => {
  if (!bunPath) return undefined;
  return bunPath.startsWith('/opt/homebrew/') ||
    bunPath.startsWith('/usr/local/')
    ? 'homebrew'
    : 'direct';
};

export const resolveSikarugir = (): string | undefined =>
  [
    '/Applications/Sikarugir Creator.app',
    join(os.homedir(), 'Applications', 'Sikarugir Creator.app'),
  ].find(existsSync);
