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

export type UpdateChannel = 'stable' | 'unstable' | 'nightly' | 'bleeding-edge';
/** Channels served from a release feed rather than built from source. */
export type ReleaseChannel = Exclude<UpdateChannel, 'bleeding-edge'>;

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
  channel: ReleaseChannel,
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
