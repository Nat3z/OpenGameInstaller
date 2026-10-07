import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

export type ChannelExecutable = 'setup' | 'application';
/** Installed versions or release tags, keyed by executable. */
export type ChannelBuilds = Partial<Record<ChannelExecutable, string>>;
type BuildKind = 'nightly' | 'release';
interface ChannelState {
  channel: UpdateChannel;
  // The kind of build each executable last ran as, so a downloaded build of another kind is noticed.
  builds: Partial<Record<ChannelExecutable, BuildKind>>;
}

function buildKind(version: string): BuildKind {
  const trimmed = version.trim();
  return trimmed.includes('-nightly.') || /^nightly-\d+$/.test(trimmed)
    ? 'nightly'
    : 'release';
}

function readState(statePath: string): ChannelState | undefined {
  if (!existsSync(statePath)) return undefined;
  const state: { channel?: unknown; builds?: unknown } = JSON.parse(
    readFileSync(statePath, 'utf8')
  );
  if (!isUpdateChannel(state.channel))
    throw new Error('Invalid saved update channel');
  const builds = state.builds ?? {};
  if (
    typeof builds !== 'object' ||
    Object.values(builds).some(
      (kind) => kind !== 'nightly' && kind !== 'release'
    )
  )
    throw new Error('Invalid saved update channel builds');
  return { channel: state.channel, builds };
}

function writeState(statePath: string, state: ChannelState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
}

/** Saves an explicit choice against the builds installed when it was made. */
export function saveChannel(
  statePath: string,
  channel: UpdateChannel,
  builds: ChannelBuilds
): void {
  let kinds: ChannelState['builds'] = {};
  try {
    kinds = readState(statePath)?.builds ?? {};
  } catch {
    // An explicit choice replaces corrupt state.
  }
  for (const [executable, version] of Object.entries(builds))
    kinds[executable as ChannelExecutable] = buildKind(version);
  writeState(statePath, { channel, builds: kinds });
}

/**
 * Saves a release-feed channel, keeping the legacy unstable marker for pre-channel setups.
 * COMMIT_EDGE.txt stays until the setup replaces the source build with a release.
 */
export function selectChannel(
  statePath: string,
  installRoot: string,
  channel: Exclude<UpdateChannel, 'bleeding-edge'>,
  builds: ChannelBuilds
): void {
  if (channel === 'unstable')
    writeFileSync(join(installRoot, 'bleeding-edge.txt'), 'true');
  else rmSync(join(installRoot, 'bleeding-edge.txt'), { force: true });
  saveChannel(statePath, channel, builds);
}

/**
 * Resolves the saved channel. Running a different kind of build than last time (a
 * downloaded nightly, or a stable build replacing a nightly) moves to that build's
 * track. Updates keep their kind, so explicit choices stick.
 */
export function resolveChannel(
  statePath: string,
  installRoot: string,
  executable: ChannelExecutable,
  version: string
): UpdateChannel {
  const kind = buildKind(version);
  const state = readState(statePath);
  const previous = state?.builds[executable];
  if (state && previous === kind) return state.channel;
  // State saved before builds were tracked cannot tell an explicit choice from the
  // automatic stable default, so a nightly build still moves it to nightly.
  const channel: UpdateChannel = !state
    ? existsSync(join(installRoot, 'COMMIT_EDGE.txt'))
      ? 'bleeding-edge'
      : existsSync(join(installRoot, 'bleeding-edge.txt'))
        ? 'unstable'
        : kind === 'nightly'
          ? 'nightly'
          : 'stable'
    : kind === 'nightly'
      ? 'nightly'
      : previous === 'nightly' && state.channel === 'nightly'
        ? 'stable'
        : state.channel;
  writeState(statePath, {
    channel,
    builds: { ...state?.builds, [executable]: kind },
  });
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
