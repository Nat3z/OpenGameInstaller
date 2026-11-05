import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Data, Effect, Schedule } from 'effect';
import semver from 'semver';
import type {
  ChannelExecutable,
  ReleaseChannel,
  UpdateChannel,
} from './channel';

const REPO = 'Nat3z/OpenGameInstaller';
// Immutable releases burn a deleted release's tag, so the old `nightly` pointer can't be reused.
export const NIGHTLY_POINTER_TAG = 'nightly-channel';
export const NIGHTLY_API = `https://api.github.com/repos/${REPO}/releases/tags/${NIGHTLY_POINTER_TAG}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const API_HEADERS = { Accept: 'application/vnd.github+json' };
const FEED_TIMEOUT_MS = 10_000;
// Downloads only fail on a stall, since large artifacts can take far longer than any fixed timeout.
const STALL_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 4;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ReleaseError extends Data.TaggedError('ReleaseError')<{
  readonly message: string;
  readonly phase: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}> {}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** GitHub's `algorithm:hex` digest. */
  digest?: string;
  /** Nightly manifests record a bare sha256 instead. */
  sha256?: string;
}

export interface ChannelRelease {
  tag_name: string;
  prerelease: boolean;
  published_at?: string | null;
  created_at: string;
  body?: string | null;
  assets: ReleaseAsset[];
}

export interface NightlyBuild {
  version: string;
  tag: string;
  source: string;
  assets: ReleaseAsset[];
  /** Assets added after schema 1 shipped, kept out of `assets` since older clients expect exact names there. */
  extraAssets?: ReleaseAsset[];
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

/**
 * Artifact names each nightly build publishes. Clients check `assets` exactly,
 * so assets added later go in `extraAssets` to keep older clients parsing.
 */
export const NIGHTLY_ASSETS = {
  application: {
    assets: [
      'OpenGameInstaller-Portable.zip',
      'OpenGameInstaller-linux-pt.AppImage',
    ],
    extraAssets: ['OpenGameInstaller-mac.zip'],
  },
  updater: {
    assets: ['OpenGameInstaller-Setup.exe', 'OpenGameInstaller-Setup.AppImage'],
    extraAssets: [],
  },
} as const;

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
  for (const kind of ['application', 'updater'] as const) {
    const build = manifest[kind];
    if (
      !build ||
      !semver.valid(build.version) ||
      !build.version.includes('-nightly.') ||
      !/^nightly-\d+$/.test(build.tag) ||
      !/^[a-f0-9]{40}$/.test(build.source)
    ) {
      throw new Error(`Invalid nightly ${kind} build`);
    }
    const { assets, extraAssets } = NIGHTLY_ASSETS[kind];
    validateNightlyAssets(build.tag, build.assets, assets, kind);
    // Manifests from before extraAssets existed don't carry them.
    if (build.extraAssets !== undefined)
      validateNightlyAssets(build.tag, build.extraAssets, extraAssets, kind);
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

/** Requires exactly one checksummed asset and blockmap per name, hosted on the build's tag. */
function validateNightlyAssets(
  tag: string,
  assets: unknown,
  names: readonly string[],
  kind: string
): void {
  const expectedNames = names.flatMap((name) => [name, `${name}.blockmap`]);
  if (!Array.isArray(assets) || assets.length !== expectedNames.length)
    throw new Error(`Unexpected nightly ${kind} assets`);
  for (const name of expectedNames) {
    const matches = (assets as ReleaseAsset[]).filter(
      (asset) => asset.name === name
    );
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !asset ||
      !(asset.size > 0) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
      asset.browser_download_url !==
        `https://github.com/${REPO}/releases/download/${tag}/${name}`
    ) {
      throw new Error(`Invalid nightly asset: ${name}`);
    }
  }
}

/** Presents one executable's nightly build as a regular release. */
export function nightlyRelease(
  manifest: NightlyManifest,
  executable: ChannelExecutable
): ChannelRelease {
  const build = manifest[executable === 'setup' ? 'updater' : 'application'];
  return {
    tag_name: build.tag,
    prerelease: true,
    published_at: manifest.publishedAt,
    created_at: manifest.publishedAt,
    body: `Setup Version: ${manifest.updater.version}\nApplication Version: ${manifest.application.version}`,
    assets: [...build.assets, ...(build.extraAssets ?? [])].map((asset) => ({
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

/** Newest first: by version when both tags are semver, otherwise by publish date. */
export function compareReleases(a: ChannelRelease, b: ChannelRelease): number {
  const versionA = semver.clean(a.tag_name);
  const versionB = semver.clean(b.tag_name);
  const order = versionA && versionB ? semver.compare(versionB, versionA) : 0;
  return (
    order ||
    Date.parse(b.published_at || b.created_at || '0') -
      Date.parse(a.published_at || a.created_at || '0')
  );
}

/** The setup version a release ships, recorded in its notes. */
export function setupVersion(release: ChannelRelease): string | undefined {
  return release.body?.match(/Setup Version: (.*)/)?.[1]?.trim() || undefined;
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

export interface ApplicationUpdate {
  release: ChannelRelease;
  /** Releases from the installed one up to the target, oldest first; empty when the installed release isn't in the feed. */
  path: ChannelRelease[];
}

/** Picks the application release to install from a sorted channel feed. */
export function findApplicationUpdate(
  releases: ChannelRelease[],
  installedTag: string,
  channel: UpdateChannel,
  installedChannel: UpdateChannel = channel
): ApplicationUpdate | undefined {
  const release = releases[0];
  if (
    !release ||
    !shouldUpdateApplication(
      installedTag,
      release.tag_name,
      channel,
      installedChannel
    )
  )
    return undefined;
  const installed = releases.findIndex(
    (candidate) => candidate.tag_name === installedTag
  );
  return {
    release,
    path: installed > 0 ? releases.slice(0, installed).reverse() : [],
  };
}

export interface SetupUpdate {
  release: ChannelRelease;
  version: string;
}

/** Picks the setup release to install from a sorted channel feed. */
export function findSetupUpdate(
  releases: ChannelRelease[],
  installedVersion: string,
  channel: UpdateChannel
): SetupUpdate | undefined {
  const installed = semver.valid(installedVersion.trim());
  const target = releases.flatMap((release) => {
    const version = semver.valid(setupVersion(release));
    return version && version !== installed ? [{ release, version }] : [];
  })[0];
  return target && shouldUpdateSetup(installedVersion, target.version, channel)
    ? target
    : undefined;
}

/** The artifact an executable installs from on this platform. */
export function platformAsset(
  release: ChannelRelease,
  executable: ChannelExecutable,
  platform: NodeJS.Platform = process.platform
): ReleaseAsset | undefined {
  const pattern =
    executable === 'setup'
      ? platform === 'win32'
        ? /-Setup\.exe$/i
        : /-Setup\.AppImage$/i
      : platform === 'win32'
        ? // Some older releases misspelled their portable archive.
          /portr?able/i
        : platform === 'darwin'
          ? /-mac\.zip$/i
          : /linux-pt\.appimage$/i;
  return release.assets.find((asset) => pattern.test(asset.name));
}

export function blockmapAsset(
  release: ChannelRelease,
  asset: ReleaseAsset
): ReleaseAsset | undefined {
  const name = `${asset.name}.blockmap`.toLowerCase();
  return release.assets.find(
    (candidate) => candidate.name.toLowerCase() === name
  );
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function isRetryable(cause: unknown): boolean {
  if (cause instanceof HttpStatusError)
    return RETRYABLE_STATUSES.has(cause.status);
  const code = (cause as { code?: unknown } | undefined)?.code;
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException && cause.name === 'TimeoutError') ||
    ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'].includes(
      String(code)
    ) ||
    /socket hang up|stalled|network/i.test(describe(cause))
  );
}

async function fetchOk(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {}
): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'OpenGameInstaller', ...headers },
    signal,
  });
  if (!response.ok) throw new HttpStatusError(response.status, url);
  return response;
}

/**
 * Fetches a channel's feed for one executable, newest first. Nightly is a single
 * build published through the pointer release; other channels filter the release list.
 */
export function fetchReleases(
  channel: ReleaseChannel,
  executable: ChannelExecutable
): Effect.Effect<ChannelRelease[], ReleaseError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const timeout = AbortSignal.any([
        signal,
        AbortSignal.timeout(FEED_TIMEOUT_MS),
      ]);
      if (channel === 'nightly') {
        const pointer: { body: string } = await (
          await fetchOk(NIGHTLY_API, timeout, API_HEADERS)
        ).json();
        return [
          nightlyRelease(
            parseNightlyManifest(JSON.parse(pointer.body)),
            executable
          ),
        ];
      }
      const releases: ChannelRelease[] = await (
        await fetchOk(RELEASES_API, timeout, API_HEADERS)
      ).json();
      return releases
        .filter((release) => acceptsRelease(channel, release))
        .sort(compareReleases);
    },
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to fetch the ${channel} release feed: ${describe(cause)}`,
        phase: 'fetch-releases',
        retryable: isRetryable(cause),
        cause,
      }),
  });
}

export interface DownloadProgress {
  written: number;
  total?: number;
  bytesPerSecond: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  /** Called before each retry with the upcoming attempt number. */
  onRetry?: (attempt: number, attempts: number, error: ReleaseError) => void;
}

async function downloadOnce(
  url: string,
  destination: string,
  signal: AbortSignal,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const stall = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => stall.abort(new Error('Download stalled')),
      STALL_TIMEOUT_MS
    );
  };
  touch();
  try {
    const combined = AbortSignal.any([signal, stall.signal]);
    const response = await fetchOk(url, combined);
    if (!response.body) throw new Error(`Empty response for ${url}`);
    const total = Number(response.headers.get('content-length')) || undefined;
    const started = Date.now();
    let written = 0;
    await pipeline(
      response.body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          touch();
          written += chunk.length;
          onProgress?.({
            written,
            total,
            bytesPerSecond:
              written / Math.max((Date.now() - started) / 1000, 1),
          });
          yield chunk;
        }
      },
      createWriteStream(destination),
      { signal: combined }
    );
  } catch (cause) {
    rmSync(destination, { force: true });
    throw stall.signal.aborted ? stall.signal.reason : cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads a release asset, retrying transient failures, then verifies it; failures leave no file behind. */
export function downloadAsset(
  asset: ReleaseAsset,
  destination: string,
  options: DownloadOptions = {}
): Effect.Effect<void, ReleaseError> {
  return Effect.suspend(() => {
    let attempt = 1;
    return Effect.tryPromise({
      try: (signal) =>
        downloadOnce(
          asset.browser_download_url,
          destination,
          signal,
          options.onProgress
        ),
      catch: (cause) =>
        new ReleaseError({
          message: `Failed to download ${asset.name}: ${describe(cause)}`,
          phase: 'download-asset',
          retryable: isRetryable(cause),
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.retryable && attempt < DOWNLOAD_ATTEMPTS)
            options.onRetry?.(++attempt, DOWNLOAD_ATTEMPTS, error);
        })
      ),
      Effect.retry({
        times: DOWNLOAD_ATTEMPTS - 1,
        schedule: Schedule.linear('1500 millis'),
        while: (error) => error.retryable === true,
      })
    );
  }).pipe(
    Effect.zipRight(verifyAsset(destination, asset)),
    // Never leave an unverified artifact where it could be installed.
    Effect.tapError(() =>
      Effect.sync(() => rmSync(destination, { force: true }))
    )
  );
}

function parseDigest(
  asset: Pick<ReleaseAsset, 'digest' | 'sha256'>
): { algorithm: string; value: string } | undefined {
  const digest = asset.digest ?? (asset.sha256 && `sha256:${asset.sha256}`);
  if (!digest) return undefined;
  const [algorithm, value] = digest.split(':', 2);
  const normalized = algorithm?.toLowerCase() ?? '';
  if (!value || !['sha256', 'sha384', 'sha512'].includes(normalized))
    throw new Error(`Unsupported digest format: ${digest}`);
  return { algorithm: normalized, value: value.toLowerCase() };
}

async function hashFile(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Checks a file against its asset's size and digest; assets without a digest only check size. */
export function verifyAsset(
  path: string,
  asset: Pick<ReleaseAsset, 'name' | 'size' | 'digest' | 'sha256'>
): Effect.Effect<void, ReleaseError> {
  return Effect.tryPromise({
    try: async () => {
      const size = statSync(path).size;
      if (asset.size > 0 && size !== asset.size)
        throw new Error(`size mismatch: expected ${asset.size}, got ${size}`);
      const digest = parseDigest(asset);
      if (digest && (await hashFile(path, digest.algorithm)) !== digest.value)
        throw new Error(`${digest.algorithm} digest mismatch`);
    },
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to verify ${asset.name}: ${describe(cause)}`,
        phase: 'verify-asset',
        cause,
      }),
  });
}

/** Formats a byte count as B, KB, MB, or GB. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(2)}KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(2)}MB`;
  return `${(size / 1024 ** 3).toFixed(2)}GB`;
}
