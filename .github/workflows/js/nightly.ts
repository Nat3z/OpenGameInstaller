import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  parseNightlyManifest,
  type NightlyManifest,
  type ReleaseAsset,
} from '../../../packages/update-channel/src/index.ts';

const repo = 'Nat3z/OpenGameInstaller';
const stateDirectory = '.nightly';
const packageDirectories = [
  'errors',
  'logger',
  'connection',
  'ogi-addon',
  'addon-server',
  'all-debrid',
  'client-kit',
  'executor',
  'real-debrid',
].map((name) => `packages/${name}`);
interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}
interface Plan {
  source: string;
  build: string;
  tag: string;
  publishedAt: string;
  changed: boolean;
  updater: boolean;
  applicationVersion: string;
  updaterVersion: string;
  packages: Record<string, string>;
  publishPackages: string[];
  previous: NightlyManifest | null;
}
interface GitHubRelease {
  id: number;
  tag_name: string;
  body: string;
  draft: boolean;
  assets: {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string;
  }[];
}

function command(program: string, args: string[], cwd = '.'): string {
  return execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function packageJson(directory: string): PackageJson {
  return readJson(`${directory}/package.json`);
}

async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  allowMissing = false
): Promise<T | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `GitHub ${method} ${path}: ${response.status} ${await response.text()}`
    );
  return response.status === 204 ? null : ((await response.json()) as T);
}

export function nightlyVersion(base: string, build: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(base);
  if (!match || !/^\d+$/.test(build))
    throw new Error(`Invalid nightly version inputs: ${base}, ${build}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-nightly.${build}`;
}

export function changedPackages(
  files: string[],
  manifests: Map<string, PackageJson>
): Set<string> {
  const global = files.some(
    (file) =>
      ['package.json', 'bun.lock', 'bunfig.toml'].includes(file) ||
      file.startsWith('.github/workflows/')
  );
  const changed = new Set(
    [...manifests]
      .filter(
        ([directory]) =>
          global || files.some((file) => file.startsWith(`${directory}/`))
      )
      .map(([, manifest]) => manifest.name)
  );
  let size: number;
  do {
    size = changed.size;
    for (const manifest of manifests.values()) {
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      };
      if (Object.keys(dependencies).some((name) => changed.has(name)))
        changed.add(manifest.name);
    }
  } while (size !== changed.size);
  return changed;
}

function changedFiles(baseline: string | undefined, source: string): string[] {
  if (!baseline) return command('git', ['ls-files']).split('\n');
  // Missing history is a failure, never a silent first-run baseline.
  return command('git', ['diff', '--name-only', baseline, source])
    .split('\n')
    .filter(Boolean);
}

function assertPublishAllowed(): void {
  if (
    process.env.GITHUB_REPOSITORY !== repo ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error(
      'Nightly publication is restricted to this repository main branch'
    );
  }
}

async function plan(): Promise<void> {
  if (process.env.NIGHTLY_PUBLISH === 'true') assertPublishAllowed();
  await api(''); // A missing/inaccessible repository must not look like a first nightly.
  const pointer = await api<GitHubRelease>(
    '/releases/tags/nightly',
    'GET',
    undefined,
    true
  );
  const previous = pointer
    ? parseNightlyManifest(JSON.parse(pointer.body))
    : null;
  const source = command('git', ['rev-parse', 'HEAD']);
  const build = process.env.GITHUB_RUN_ID;
  if (!build || !/^\d+$/.test(build))
    throw new Error('GITHUB_RUN_ID is required');
  const files = changedFiles(previous?.source, source);
  const updaterFiles = changedFiles(previous?.updater.source, source);
  const globalInput = (file: string): boolean =>
    ['package.json', 'bun.lock', 'bunfig.toml'].includes(file) ||
    file.startsWith('.github/workflows/');
  const forced = process.env.NIGHTLY_FORCE === 'true';
  const changed =
    forced ||
    !previous ||
    files.some(
      (file) =>
        globalInput(file) || /^(application|updater|packages)\//.test(file)
    );
  const updater =
    forced ||
    !previous ||
    updaterFiles.some(
      (file) =>
        globalInput(file) ||
        /^(updater|packages\/(logger|update-channel))\//.test(file)
    );
  const manifests = new Map(
    packageDirectories.map((directory) => [directory, packageJson(directory)])
  );
  const changedNames = changedPackages(files, manifests);
  const packages: Record<string, string> = {};
  for (const manifest of manifests.values()) {
    packages[manifest.name] = changedNames.has(manifest.name)
      ? nightlyVersion(manifest.version, build)
      : (previous?.packages[manifest.name] ?? manifest.version);
  }
  const result: Plan = {
    source,
    build,
    tag: `nightly-${build}`,
    changed,
    updater,
    publishedAt: command('git', ['show', '-s', '--format=%cI', source]),
    applicationVersion: nightlyVersion(
      packageJson('application').version,
      build
    ),
    updaterVersion: updater
      ? nightlyVersion(packageJson('updater').version, build)
      : previous!.updater.version,
    packages,
    publishPackages: [...changedNames],
    previous,
  };
  mkdirSync(stateDirectory, { recursive: true });
  writeJson(`${stateDirectory}/plan.json`, result);
  for (const [name, value] of Object.entries({ changed, updater, source })) {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function stamp(plan: Plan): void {
  if (command('git', ['rev-parse', 'HEAD']) !== plan.source)
    throw new Error('Nightly source mismatch');
  for (const directory of ['application', 'updater', ...packageDirectories]) {
    const manifest = packageJson(directory);
    manifest.version =
      directory === 'application'
        ? plan.applicationVersion
        : directory === 'updater'
          ? plan.updaterVersion
          : plan.packages[manifest.name]!;
    if (directory === 'application' || directory === 'updater') {
      // Windows numeric file versions cannot contain our large workflow run ID.
      manifest.build = {
        ...(manifest.build as Record<string, unknown>),
        buildVersion: `${manifest.version.split('-')[0]}.0`,
      };
    }
    // The frozen source install has already run. Only packaging metadata changes.
    if (
      packageDirectories.includes(directory) &&
      plan.publishPackages.includes(manifest.name)
    ) {
      for (const field of [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
      ] as const) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (plan.packages[name])
            manifest[field]![name] = plan.packages[name]!;
        }
      }
    }
    writeJson(`${directory}/package.json`, manifest);
  }
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? collectFiles(join(directory, entry.name))
      : [join(directory, entry.name)]
  );
}

function assetsFor(
  plan: Plan,
  kind: 'application' | 'updater'
): ReleaseAsset[] {
  const names =
    kind === 'application'
      ? [
          'OpenGameInstaller-Portable.zip',
          'OpenGameInstaller-linux-pt.AppImage',
        ]
      : ['OpenGameInstaller-Setup.exe', 'OpenGameInstaller-Setup.AppImage'];
  const files = collectFiles(`${stateDirectory}/assets`);
  return names
    .flatMap((name) => [name, `${name}.blockmap`])
    .map((name) => {
      const matches = files.filter(
        (file) => file.split(/[\\/]/).at(-1) === name
      );
      if (matches.length !== 1) throw new Error(`Expected exactly one ${name}`);
      const bytes = readFileSync(matches[0]!);
      if (!bytes.length) throw new Error(`Empty artifact ${name}`);
      if (!name.endsWith('.blockmap'))
        validateBlockmap(bytes.length, readFileSync(`${matches[0]}.blockmap`));
      return {
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        browser_download_url: `https://github.com/${repo}/releases/download/${plan.tag}/${name}`,
      };
    });
}

export function validateBlockmap(size: number, compressed: Uint8Array): void {
  const blockmap = JSON.parse(gunzipSync(compressed).toString('utf8')) as {
    files?: { offset: number; sizes: number[]; checksums: string[] }[];
  };
  if (!Array.isArray(blockmap.files) || blockmap.files.length !== 1)
    throw new Error('Invalid blockmap files');
  const file = blockmap.files[0]!;
  if (
    !Array.isArray(file.sizes) ||
    !Array.isArray(file.checksums) ||
    file.sizes.length !== file.checksums.length ||
    !file.sizes.length ||
    file.sizes.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    file.checksums.some((value) => typeof value !== 'string' || !value) ||
    (file.offset || 0) + file.sizes.reduce((sum, value) => sum + value, 0) !==
      size
  ) {
    throw new Error('Blockmap does not match artifact size');
  }
}

async function registryVersion(
  name: string,
  version: string,
  tarball: string
): Promise<boolean> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(60000) }
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`npm lookup ${name}: ${response.status}`);
  const manifest = (await response.json()) as {
    version: string;
    dist?: { integrity?: string };
  };
  if (manifest.version !== version)
    throw new Error(`npm returned unexpected version for ${name}`);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  if (manifest.dist?.integrity !== integrity)
    throw new Error(`Immutable npm tarball mismatch: ${name}@${version}`);
  return true;
}

function packAndValidate(): Map<string, string> {
  const tarballDirectory = resolve(`${stateDirectory}/tarballs`);
  mkdirSync(tarballDirectory, { recursive: true });
  const tarballs = new Map<string, string>();
  for (const directory of packageDirectories) {
    const output = JSON.parse(
      command(
        'npm',
        ['pack', '--json', '--pack-destination', tarballDirectory],
        directory
      )
    ) as { filename: string }[];
    tarballs.set(
      packageJson(directory).name,
      join(tarballDirectory, output[0]!.filename)
    );
  }
  const installDirectory = resolve(`${stateDirectory}/verify`);
  mkdirSync(installDirectory, { recursive: true });
  command('npm', [
    'install',
    '--ignore-scripts',
    '--prefix',
    installDirectory,
    ...tarballs.values(),
  ]);
  for (const name of tarballs.keys()) {
    const directory = join(installDirectory, 'node_modules', name);
    const manifest = packageJson(directory);
    if (JSON.stringify(manifest).includes('workspace:'))
      throw new Error(`Publish-unsafe workspace range: ${name}`);
    const targets = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('./'))
        targets.add(value);
      else if (value && typeof value === 'object')
        Object.values(value).forEach(collect);
    };
    for (const field of [
      'main',
      'module',
      'types',
      'typings',
      'bin',
      'exports',
    ])
      collect(manifest[field]);
    for (const target of targets)
      if (!existsSync(resolve(directory, target)))
        throw new Error(`${name} missing entrypoint ${target}`);
    command('node', [
      '-e',
      'require.resolve(process.argv[1], {paths:[process.argv[2]]})',
      name,
      installDirectory,
    ]);
  }
  return tarballs;
}

async function publish(plan: Plan): Promise<void> {
  const manifest: NightlyManifest = parseNightlyManifest({
    schema: 1,
    source: plan.source,
    build: plan.build,
    publishedAt: plan.publishedAt,
    application: {
      version: plan.applicationVersion,
      tag: plan.tag,
      source: plan.source,
      assets: assetsFor(plan, 'application'),
    },
    updater: plan.updater
      ? {
          version: plan.updaterVersion,
          tag: plan.tag,
          source: plan.source,
          assets: assetsFor(plan, 'updater'),
        }
      : plan.previous!.updater,
    packages: plan.packages,
  });
  const tarballs =
    process.env.NIGHTLY_PUBLISH === 'true'
      ? new Map(
          readJson<{ name: string; file: string; sha512: string }[]>(
            `${stateDirectory}/tarballs.json`
          ).map((item) => {
            const file = resolve(
              stateDirectory,
              'tarballs',
              basename(item.file)
            );
            if (
              createHash('sha512')
                .update(readFileSync(file))
                .digest('base64') !== item.sha512
            )
              throw new Error(`Validated tarball changed: ${item.name}`);
            return [item.name, file];
          })
        )
      : packAndValidate();
  if (process.env.NIGHTLY_PUBLISH !== 'true') {
    writeJson(`${stateDirectory}/nightly.json`, manifest);
    writeJson(
      `${stateDirectory}/tarballs.json`,
      [...tarballs].map(([name, file]) => ({
        name,
        file: basename(file),
        sha512: createHash('sha512')
          .update(readFileSync(file))
          .digest('base64'),
      }))
    );
    console.log(
      'Dry run validated: no releases, npm versions, or channel pointers changed.'
    );
    return;
  }
  if (
    JSON.stringify(readJson(`${stateDirectory}/nightly.json`)) !==
    JSON.stringify(manifest)
  )
    throw new Error('Validated manifest changed');
  assertPublishAllowed();
  const pointer = await api<GitHubRelease>(
    '/releases/tags/nightly',
    'GET',
    undefined,
    true
  );
  const current = pointer
    ? parseNightlyManifest(JSON.parse(pointer.body))
    : null;
  if (current && BigInt(current.build) > BigInt(plan.build))
    throw new Error('Refusing to promote an older rerun');
  if (
    current &&
    current.build !== plan.build &&
    current.build !== plan.previous?.build
  )
    throw new Error('Nightly baseline changed; start a fresh run');
  // Keep the public feed bounded even if a prior run failed after release publication.
  const releases = await listReleases();
  if (
    releases.filter(
      (release) => /^nightly-\d+$/.test(release.tag_name) && !release.draft
    ).length >= 8
  )
    throw new Error(
      'Nightly retention limit reached; clean up orphan releases before retrying'
    );
  for (const directory of packageDirectories) {
    const pkg = packageJson(directory);
    if (!plan.publishPackages.includes(pkg.name)) continue;
    if (
      !(await registryVersion(pkg.name, pkg.version, tarballs.get(pkg.name)!))
    ) {
      command('npm', [
        'publish',
        tarballs.get(pkg.name)!,
        '--access',
        'public',
        '--tag',
        'nightly-staging',
      ]);
    }
  }
  let release = await api<GitHubRelease>(
    `/releases/tags/${plan.tag}`,
    'GET',
    undefined,
    true
  );
  if (!release)
    release = await api<GitHubRelease>('/releases', 'POST', {
      tag_name: plan.tag,
      target_commitish: plan.source,
      name: `Nightly ${plan.build}`,
      body: `Setup Version: ${manifest.updater.version}\nApplication Version: ${manifest.application.version}`,
      draft: true,
      prerelease: true,
      make_latest: 'false',
    });
  if (!release) throw new Error('Missing nightly release');
  const localFiles = collectFiles(`${stateDirectory}/assets`);
  for (const asset of [
    ...manifest.application.assets,
    ...(plan.updater ? manifest.updater.assets : []),
  ]) {
    const existing = release.assets.find((item) => item.name === asset.name);
    if (existing) {
      if (
        existing.size !== asset.size ||
        existing.digest !== `sha256:${asset.sha256}`
      )
        throw new Error(`Immutable artifact mismatch: ${asset.name}`);
      continue;
    }
    if (!release.draft)
      throw new Error('Cannot add artifacts to a published nightly');
    const file = localFiles.find(
      (file) => file.split(/[\\/]/).at(-1) === asset.name
    )!;
    command('gh', ['release', 'upload', plan.tag, file, '--repo', repo]);
  }
  if (
    !release.assets.some((asset) => asset.name === 'nightly.json') &&
    release.draft
  )
    command('gh', [
      'release',
      'upload',
      plan.tag,
      `${stateDirectory}/nightly.json`,
      '--repo',
      repo,
    ]);
  // Validate reused installer URLs before advancing the pointer.
  for (const asset of manifest.updater.assets) {
    if (plan.updater) break;
    const response = await fetch(asset.browser_download_url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(60000),
    });
    if (
      !response.ok ||
      Number(response.headers.get('content-length')) !== asset.size
    )
      throw new Error(`Reused installer unavailable: ${asset.name}`);
  }
  await api(`/releases/${release.id}`, 'PATCH', {
    draft: false,
    prerelease: true,
    make_latest: 'false',
  });
  for (const name of plan.publishPackages)
    command('npm', [
      'dist-tag',
      'add',
      `${name}@${plan.packages[name]}`,
      'nightly',
    ]);
  // One release-body update atomically promotes the complete structured manifest.
  if (pointer)
    await api(`/releases/${pointer.id}`, 'PATCH', {
      body: JSON.stringify(manifest),
      prerelease: true,
      make_latest: 'false',
    });
  else
    await api('/releases', 'POST', {
      tag_name: 'nightly',
      target_commitish: plan.source,
      name: 'Nightly channel',
      body: JSON.stringify(manifest),
      prerelease: true,
      make_latest: 'false',
    });
  const published = (await listReleases())
    .filter((item) => /^nightly-\d+$/.test(item.tag_name) && !item.draft)
    .sort((a, b) =>
      Number(BigInt(b.tag_name.slice(8)) - BigInt(a.tag_name.slice(8)))
    );
  const keep = new Set([
    manifest.application.tag,
    manifest.updater.tag,
    ...published.slice(0, 3).map((item) => item.tag_name),
  ]);
  for (const old of published) {
    if (!keep.has(old.tag_name))
      command('gh', [
        'release',
        'delete',
        old.tag_name,
        '--cleanup-tag',
        '--yes',
        '--repo',
        repo,
      ]);
  }
}

async function listReleases(): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<GitHubRelease[]>(
      `/releases?per_page=100&page=${page}`
    );
    if (!batch) throw new Error('Missing release list');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

if (import.meta.main) {
  const operation = process.argv[2];
  if (operation === 'plan') await plan();
  else {
    const stored = readJson<Plan>(`${stateDirectory}/plan.json`);
    if (operation === 'stamp') stamp(stored);
    else if (operation === 'publish') await publish(stored);
    else throw new Error(`Unknown nightly operation: ${operation}`);
  }
}
