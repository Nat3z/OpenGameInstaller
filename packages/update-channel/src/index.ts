import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import semver from 'semver';

export type UpdateChannel = 'stable' | 'unstable' | 'nightly' | 'bleeding-edge';
export const NIGHTLY_API =
  'https://api.github.com/repos/Nat3z/OpenGameInstaller/releases/tags/nightly';

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return (
    value === 'stable' ||
    value === 'unstable' ||
    value === 'nightly' ||
    value === 'bleeding-edge'
  );
}

// Both executables use appData (not their different Electron userData paths).
// Key by installation root so portable and installed copies remain independent.
export function channelStatePath(appData: string, installRoot: string): string {
  const root = resolve(installRoot);
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? root.toLowerCase() : root)
    .digest('hex');
  return join(appData, 'OpenGameInstaller', 'channels', `${key}.json`);
}

export function saveChannel(statePath: string, channel: UpdateChannel): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ channel }));
  renameSync(temporary, statePath);
}

export function resolveChannel(
  statePath: string,
  installRoot: string,
  embeddedVersion: string
): UpdateChannel {
  if (existsSync(statePath)) {
    const state: { channel?: unknown } = JSON.parse(
      readFileSync(statePath, 'utf8')
    );
    if (!isUpdateChannel(state.channel))
      throw new Error('Invalid saved update channel');
    return state.channel;
  }
  const channel: UpdateChannel = existsSync(
    join(installRoot, 'COMMIT_EDGE.txt')
  )
    ? 'bleeding-edge'
    : existsSync(join(installRoot, 'bleeding-edge.txt'))
      ? 'unstable'
      : embeddedVersion.includes('-nightly.')
        ? 'nightly'
        : 'stable';
  saveChannel(statePath, channel);
  return channel;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  sha256?: string;
}

export interface ChannelRelease {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  created_at: string;
  body: string;
  assets: ReleaseAsset[];
}

export interface NightlyBuild {
  version: string;
  tag: string;
  source: string;
  assets: ReleaseAsset[];
}

export interface NightlyManifest {
  schema: 1;
  source: string;
  build: string;
  publishedAt: string;
  application: NightlyBuild;
  updater: NightlyBuild;
  packages: Record<string, string>;
}

export function parseNightlyManifest(value: unknown): NightlyManifest {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid nightly manifest');
  const manifest = value as NightlyManifest;
  if (
    manifest.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.source) ||
    !/^\d+$/.test(manifest.build) ||
    !Number.isFinite(Date.parse(manifest.publishedAt))
  ) {
    throw new Error('Invalid nightly manifest identity');
  }
  for (const [kind, names] of Object.entries({
    application: [
      'OpenGameInstaller-Portable.zip',
      'OpenGameInstaller-linux-pt.AppImage',
    ],
    updater: [
      'OpenGameInstaller-Setup.exe',
      'OpenGameInstaller-Setup.AppImage',
    ],
  })) {
    const build = manifest[kind as 'application' | 'updater'];
    if (
      !build ||
      !semver.valid(build.version) ||
      !build.version.includes('-nightly.') ||
      !/^nightly-\d+$/.test(build.tag) ||
      !/^[a-f0-9]{40}$/.test(build.source) ||
      !Array.isArray(build.assets)
    ) {
      throw new Error(`Invalid nightly ${kind} build`);
    }
    const expectedNames = names.flatMap((name) => [name, `${name}.blockmap`]);
    if (build.assets.length !== expectedNames.length)
      throw new Error(`Unexpected nightly ${kind} assets`);
    for (const name of expectedNames) {
      const assets = build.assets.filter((asset) => asset.name === name);
      const asset = assets[0];
      if (
        assets.length !== 1 ||
        !asset ||
        !(asset.size > 0) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
        asset.browser_download_url !==
          `https://github.com/Nat3z/OpenGameInstaller/releases/download/${build.tag}/${name}`
      ) {
        throw new Error(`Invalid nightly asset: ${name}`);
      }
    }
  }
  if (
    !manifest.packages ||
    typeof manifest.packages !== 'object' ||
    Object.values(manifest.packages).some(
      (version) => typeof version !== 'string' || !semver.valid(version)
    )
  ) {
    throw new Error('Invalid nightly SDK versions');
  }
  return manifest;
}

export function nightlyRelease(
  manifest: NightlyManifest,
  kind: 'application' | 'updater'
): ChannelRelease {
  const build = manifest[kind];
  return {
    tag_name: build.tag,
    prerelease: true,
    published_at: manifest.publishedAt,
    created_at: manifest.publishedAt,
    body: `Setup Version: ${manifest.updater.version}\nApplication Version: ${manifest.application.version}`,
    assets: build.assets.map((asset) => ({
      ...asset,
      digest: `sha256:${asset.sha256}`,
    })),
  };
}

export function acceptsRelease(
  channel: UpdateChannel,
  release: { tag_name: string; prerelease?: boolean }
): boolean {
  if (release.tag_name === 'nightly' || release.tag_name.startsWith('nightly-'))
    return false;
  return channel === 'unstable' || !release.prerelease;
}

export function shouldUpdateSetup(
  localVersion: string,
  wantedVersion: string,
  channel: UpdateChannel
): boolean {
  const local = semver.valid(localVersion.trim());
  const wanted = semver.valid(wantedVersion.trim());
  if (!wanted) return false;
  if (!local) return true;
  // Explicitly leaving nightly is allowed to install the older stable setup.
  return (
    semver.gt(wanted, local) ||
    (channel !== 'nightly' &&
      local.includes('-nightly.') &&
      !wanted.includes('-nightly.'))
  );
}

export function shouldUpdateApplication(
  localTag: string,
  targetTag: string,
  channel: UpdateChannel,
  installedChannel: UpdateChannel = channel
): boolean {
  // Source builds replace the payload without updating its last release tag.
  if (installedChannel === 'bleeding-edge' && channel !== 'bleeding-edge')
    return true;
  if (localTag === targetTag) return false;
  const local = /^nightly-(\d+)$/.exec(localTag);
  const target = /^nightly-(\d+)$/.exec(targetTag);
  if (channel === 'nightly' && local && target)
    return BigInt(target[1]!) > BigInt(local[1]!);
  const localVersion = semver.valid(localTag.trim());
  const targetVersion = semver.valid(targetTag.trim());
  if (localVersion && targetVersion)
    return semver.gt(targetVersion, localVersion);
  return true;
}
