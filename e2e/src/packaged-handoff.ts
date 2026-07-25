import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type PackagedHandoffPlatform = 'linux' | 'win32';

export type PackagedHandoffRunDescriptor = {
  version: 1;
  scenario: 'packaged-updater-application-handoff';
  runId: string;
  platform: PackagedHandoffPlatform;
  sandboxDirectory: string;
  updaterUserDataDirectory: string;
  applicationUserDataDirectory: string;
  applicationStateDirectory: string;
  packagedUpdaterDirectory: string;
  installationDirectory: string;
  backupDirectory: string;
  stagingDirectory: string;
  artifactDirectory: string;
  fixtureStateDirectory: string;
  eventLogPath: string;
  handoffLogPath: string;
  startupHealthPath: string;
  fixtureBaseUrl: string;
  releaseApiUrl: string;
  artifactUrl: string;
  automationPort: number;
  clientSdkPort: number;
  healthTimeoutMs: number;
};

type PackagedHandoffArtifactInput = {
  outputDirectory: string;
  applicationBundleDirectory: string;
  applicationMainPath: string;
  fixtureServicePath: string;
  descriptorValidatorPath: string;
  updaterBundleDirectory: string;
  updaterPublicDirectory: string;
  updaterMainPath: string;
  fixtureAddonDirectory: string;
  fixtureWebSocketModuleDirectory: string;
};

export type PackagedHandoffBuild = {
  platform: PackagedHandoffPlatform;
  syntheticOldInstallationDirectory: string;
  packagedUpdaterDirectory: string;
  currentApplicationArtifactPath: string;
};

type PackagedHandoffDescriptorWithPath = PackagedHandoffRunDescriptor & {
  descriptorPath: string;
};

export type PackagedApplicationLaunch = {
  entryPoint: string;
  args: string[];
  environment: { OGI_RUN_DESCRIPTOR: string };
};

type StartupHealth = {
  version: 1;
  runId: string;
  state: 'interactive';
};

type ArtifactFile = {
  path: string;
  mode: number;
  contents: string;
};

const require = createRequire(import.meta.url);
const { validatePackagedHandoffRunDescriptor } =
  require('./packaged-handoff-run-descriptor.cjs') as {
    validatePackagedHandoffRunDescriptor(
      value: unknown
    ): PackagedHandoffRunDescriptor;
  };

export function parsePackagedHandoffRunDescriptor(
  value: unknown
): PackagedHandoffRunDescriptor {
  return validatePackagedHandoffRunDescriptor(value);
}

export function readPackagedHandoffRunDescriptor(path: string) {
  return parsePackagedHandoffRunDescriptor(
    JSON.parse(readFileSync(path, 'utf8'))
  );
}

export function createPackagedHandoffSandbox(
  runId: string,
  platform: PackagedHandoffPlatform
) {
  const sandboxDirectory = mkdtempSync(
    join(tmpdir(), `ogi-packaged-handoff-${runId}-`)
  );
  const descriptorPath = join(sandboxDirectory, 'run-descriptor.json');
  const fixtureBaseUrl = 'http://127.0.0.1:1';
  const descriptor = parsePackagedHandoffRunDescriptor({
    version: 1,
    scenario: 'packaged-updater-application-handoff',
    runId,
    platform,
    sandboxDirectory,
    updaterUserDataDirectory: join(sandboxDirectory, 'updater-user-data'),
    applicationUserDataDirectory: join(
      sandboxDirectory,
      'application-user-data'
    ),
    applicationStateDirectory: join(sandboxDirectory, 'application-state'),
    packagedUpdaterDirectory: join(sandboxDirectory, 'packaged-updater'),
    installationDirectory: join(sandboxDirectory, 'installation'),
    backupDirectory: join(sandboxDirectory, 'last-known-good'),
    stagingDirectory: join(sandboxDirectory, 'staging'),
    artifactDirectory: join(sandboxDirectory, 'artifacts'),
    fixtureStateDirectory: join(sandboxDirectory, 'fixture-state'),
    eventLogPath: join(sandboxDirectory, 'events.jsonl'),
    handoffLogPath: join(sandboxDirectory, 'artifacts', 'handoff.jsonl'),
    startupHealthPath: join(sandboxDirectory, 'startup-health.json'),
    fixtureBaseUrl,
    releaseApiUrl: `${fixtureBaseUrl}/releases`,
    artifactUrl: `${fixtureBaseUrl}/artifacts/current.json`,
    automationPort: 9222,
    clientSdkPort: 7654,
    healthTimeoutMs: 30000,
  });
  for (const directory of [
    descriptor.updaterUserDataDirectory,
    descriptor.applicationUserDataDirectory,
    descriptor.applicationStateDirectory,
    descriptor.packagedUpdaterDirectory,
    descriptor.installationDirectory,
    descriptor.stagingDirectory,
    descriptor.artifactDirectory,
    descriptor.fixtureStateDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
  return { ...descriptor, descriptorPath };
}

export function writePackagedHandoffRunDescriptor(
  descriptor: PackagedHandoffDescriptorWithPath,
  fixtureBaseUrl: string,
  automationPort: number,
  clientSdkPort: number
) {
  const { descriptorPath, ...current } = descriptor;
  const configured = parsePackagedHandoffRunDescriptor({
    ...current,
    fixtureBaseUrl,
    releaseApiUrl: `${fixtureBaseUrl}/releases`,
    artifactUrl: `${fixtureBaseUrl}/artifacts/current.json`,
    automationPort,
    clientSdkPort,
  });
  writeFileSync(descriptorPath, JSON.stringify(configured, null, 2));
  return { ...configured, descriptorPath };
}

function collectArtifactFiles(root: string, destinationRoot: string) {
  const files: ArtifactFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      const destinationPath = join(
        destinationRoot,
        relative(root, sourcePath)
      ).replaceAll('\\', '/');
      files.push({
        path: destinationPath,
        mode: statSync(sourcePath).mode & 0o777,
        contents: readFileSync(sourcePath).toString('base64'),
      });
    }
  };
  visit(root);
  return files;
}

function artifactFile(sourcePath: string, destinationPath: string) {
  return {
    path: destinationPath,
    mode: statSync(sourcePath).mode & 0o777,
    contents: readFileSync(sourcePath).toString('base64'),
  };
}

function launcherName(platform: PackagedHandoffPlatform) {
  return platform === 'win32'
    ? 'OpenGameInstaller.exe'
    : 'OpenGameInstaller.AppImage';
}

export function buildPackagedHandoffArtifacts(
  input: PackagedHandoffArtifactInput
): PackagedHandoffBuild[] {
  mkdirSync(input.outputDirectory, { recursive: true });
  return (['linux', 'win32'] as const).map((platform) => {
    const platformDirectory = join(input.outputDirectory, platform);
    const syntheticOldInstallationDirectory = join(
      platformDirectory,
      'synthetic-old'
    );
    const packagedUpdaterDirectory = join(platformDirectory, 'updater');
    rmSync(platformDirectory, { recursive: true, force: true });
    mkdirSync(syntheticOldInstallationDirectory, { recursive: true });
    writeFileSync(
      join(syntheticOldInstallationDirectory, 'version.txt'),
      'v0.0.1-e2e'
    );
    const oldLauncher = join(
      syntheticOldInstallationDirectory,
      launcherName(platform)
    );
    writeFileSync(
      oldLauncher,
      platform === 'linux'
        ? '#!/bin/sh\nprintf "synthetic old installation\\n"\n'
        : '@echo off\r\necho synthetic old installation\r\n'
    );
    if (platform === 'linux') chmodSync(oldLauncher, 0o755);
    cpSync(
      input.updaterBundleDirectory,
      join(packagedUpdaterDirectory, 'dist'),
      {
        recursive: true,
      }
    );
    cpSync(
      input.updaterPublicDirectory,
      join(packagedUpdaterDirectory, 'public'),
      { recursive: true }
    );
    cpSync(
      input.updaterMainPath,
      join(packagedUpdaterDirectory, 'e2e-product-main.cjs')
    );
    writeFileSync(
      join(packagedUpdaterDirectory, 'package.json'),
      JSON.stringify({ type: 'module' })
    );
    mkdirSync(join(packagedUpdaterDirectory, 'support'), { recursive: true });
    cpSync(
      input.descriptorValidatorPath,
      join(
        packagedUpdaterDirectory,
        'support/packaged-handoff-run-descriptor.cjs'
      )
    );

    const files = [
      ...collectArtifactFiles(input.applicationBundleDirectory, 'app/out'),
      ...collectArtifactFiles(
        input.fixtureAddonDirectory,
        'app/ogi-e2e-fixture-addon'
      ),
      ...collectArtifactFiles(
        input.fixtureWebSocketModuleDirectory,
        'support/node_modules/ws'
      ),
      artifactFile(input.applicationMainPath, 'app/e2e-product-main.cjs'),
      artifactFile(input.fixtureServicePath, 'support/fixture-service.cjs'),
      artifactFile(
        input.descriptorValidatorPath,
        'support/packaged-handoff-run-descriptor.cjs'
      ),
    ];
    const currentApplicationArtifactPath = join(
      platformDirectory,
      `OpenGameInstaller-${platform}-e2e.json`
    );
    mkdirSync(platformDirectory, { recursive: true });
    writeFileSync(
      currentApplicationArtifactPath,
      JSON.stringify({
        formatVersion: 1,
        product: 'OpenGameInstaller',
        platform,
        version: 'v4.1.0-e2e',
        entryPoint: 'app/e2e-product-main.cjs',
        executable: launcherName(platform),
        files,
      })
    );
    return {
      platform,
      syntheticOldInstallationDirectory,
      packagedUpdaterDirectory,
      currentApplicationArtifactPath,
    };
  });
}

export function copySyntheticOldInstallation(
  sourceDirectory: string,
  installationDirectory: string
) {
  rmSync(installationDirectory, { recursive: true, force: true });
  cpSync(sourceDirectory, installationDirectory, { recursive: true });
}

function containedArtifactPath(root: string, artifactPath: string) {
  const destination = resolve(root, artifactPath);
  const fromRoot = relative(resolve(root), destination);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Packaged application path is unsafe: ${artifactPath}`);
  }
  return destination;
}

function stagePackagedApplication(
  descriptor: PackagedHandoffDescriptorWithPath,
  artifactPath: string
) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    formatVersion: number;
    platform: string;
    version: string;
    entryPoint: string;
    executable: string;
    files: ArtifactFile[];
  };
  if (
    artifact.formatVersion !== 1 ||
    artifact.platform !== descriptor.platform ||
    artifact.version !== 'v4.1.0-e2e' ||
    artifact.entryPoint !== 'app/e2e-product-main.cjs' ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('Packaged application artifact is invalid');
  }
  rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
  mkdirSync(descriptor.stagingDirectory, { recursive: true });
  for (const file of artifact.files) {
    if (
      typeof file.path !== 'string' ||
      typeof file.contents !== 'string' ||
      !Number.isInteger(file.mode)
    ) {
      throw new Error('Packaged application file entry is invalid');
    }
    const destination = containedArtifactPath(
      descriptor.stagingDirectory,
      file.path
    );
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, Buffer.from(file.contents, 'base64'));
    chmodSync(destination, file.mode);
  }
  writeFileSync(
    join(descriptor.stagingDirectory, 'version.txt'),
    artifact.version
  );
  const launcher = containedArtifactPath(
    descriptor.stagingDirectory,
    artifact.executable
  );
  writeFileSync(
    launcher,
    descriptor.platform === 'linux'
      ? '#!/bin/sh\nexec electron "$(dirname "$0")/app/e2e-product-main.cjs" "$@"\n'
      : '@echo off\r\nelectron "%~dp0app\\e2e-product-main.cjs" %*\r\n'
  );
  if (descriptor.platform === 'linux') chmodSync(launcher, 0o755);
  return {
    entryPoint: containedArtifactPath(
      descriptor.stagingDirectory,
      artifact.entryPoint
    ),
  };
}

async function waitForStartupHealth(
  descriptor: PackagedHandoffDescriptorWithPath
): Promise<StartupHealth> {
  const deadline = Date.now() + descriptor.healthTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(descriptor.startupHealthPath)) {
      const value = JSON.parse(
        readFileSync(descriptor.startupHealthPath, 'utf8')
      ) as StartupHealth;
      if (
        value.version === 1 &&
        value.runId === descriptor.runId &&
        value.state === 'interactive'
      ) {
        return value;
      }
      throw new Error('Startup Health Signal is invalid');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Startup Health Signal did not arrive before the deadline');
}

export async function performRecoverableHandoff(input: {
  descriptor: PackagedHandoffDescriptorWithPath;
  currentApplicationArtifactPath: string;
  launchApplication: (launch: PackagedApplicationLaunch) => Promise<void>;
}) {
  const staged = stagePackagedApplication(
    input.descriptor,
    input.currentApplicationArtifactPath
  );
  rmSync(input.descriptor.backupDirectory, { recursive: true, force: true });
  cpSync(
    input.descriptor.installationDirectory,
    input.descriptor.backupDirectory,
    { recursive: true }
  );
  rmSync(input.descriptor.installationDirectory, {
    recursive: true,
    force: true,
  });
  renameSync(
    input.descriptor.stagingDirectory,
    input.descriptor.installationDirectory
  );
  const entryPoint = join(
    input.descriptor.installationDirectory,
    relative(input.descriptor.stagingDirectory, staged.entryPoint)
  );
  await input.launchApplication({
    entryPoint,
    args: [
      `--remote-debugging-port=${input.descriptor.automationPort}`,
      ...(input.descriptor.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    environment: {
      OGI_RUN_DESCRIPTOR: input.descriptor.descriptorPath,
    },
  });
  const health = await waitForStartupHealth(input.descriptor);
  rmSync(input.descriptor.backupDirectory, { recursive: true, force: true });
  return { health, entryPoint };
}

export async function startPackagedHandoffFixture(
  fixtureStateDirectory: string,
  currentApplicationArtifactPath: string
) {
  mkdirSync(fixtureStateDirectory, { recursive: true });
  const requestLogPath = join(fixtureStateDirectory, 'requests.jsonl');
  writeFileSync(requestLogPath, '');
  const artifactContents = readFileSync(currentApplicationArtifactPath);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const isReleases =
      request.method === 'GET' && requestUrl.pathname === '/releases';
    const isArtifact =
      request.method === 'GET' &&
      requestUrl.pathname === '/artifacts/current.json';
    const isGame =
      ['GET', 'HEAD'].includes(request.method ?? '') &&
      requestUrl.pathname === '/games/golden-journey.txt';
    const isImage =
      request.method === 'GET' &&
      requestUrl.pathname === '/images/golden-journey.svg';
    const status = isReleases || isArtifact || isGame || isImage ? 200 : 404;
    appendFileSync(
      requestLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        status,
      })}\n`
    );
    if (isReleases) {
      const address = server.address();
      if (!address || typeof address === 'string') {
        response.writeHead(500);
        response.end();
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([
          {
            tag_name: 'v4.1.0-e2e',
            prerelease: false,
            assets: [
              {
                name: 'OpenGameInstaller-e2e.json',
                browser_download_url: `${baseUrl}/artifacts/current.json`,
              },
            ],
          },
        ])
      );
      return;
    }
    if (isArtifact) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': artifactContents.byteLength,
      });
      response.end(artifactContents);
      return;
    }
    if (isGame) {
      const body = 'OpenGameInstaller Golden Journey fixture\n';
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(body),
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (isImage) {
      const body =
        '<svg xmlns="http://www.w3.org/2000/svg" width="375" height="500"><rect width="100%" height="100%" fill="#6d5dfc"/><text x="50%" y="50%" fill="white" text-anchor="middle">Golden Journey</text></svg>';
      response.writeHead(200, {
        'content-type': 'image/svg+xml',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: 'Unexpected Fixture Service request' })
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fixture Service did not allocate a loopback port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestLogPath,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

export function verifyProductionPackagingBoundary(repositoryDirectory: string) {
  const applicationPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'application/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const updaterPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'updater/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const applicationIncludedPaths = applicationPackage.build?.files ?? [];
  const updaterIncludedPaths = updaterPackage.build?.files ?? [];
  for (const includedPath of [
    ...applicationIncludedPaths,
    ...updaterIncludedPaths,
  ]) {
    if (/e2e|run-descriptor/i.test(includedPath)) {
      throw new Error(
        `Production packaging includes an E2E path: ${includedPath}`
      );
    }
  }

  const activeHookMatches: string[] = [];
  const scan = (root: string) => {
    if (!existsSync(root)) {
      throw new Error(`Production packaging input is missing: ${root}`);
    }
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (entry.name.endsWith('.map')) continue;
        const contents = readFileSync(path);
        if (
          contents.includes(Buffer.from('OGI_RUN_DESCRIPTOR')) ||
          contents.includes(Buffer.from('packaged-updater-application-handoff'))
        ) {
          activeHookMatches.push(relative(repositoryDirectory, path));
        }
      }
    };
    visit(root);
  };
  scan(join(repositoryDirectory, 'application/out'));
  scan(join(repositoryDirectory, 'updater/dist'));
  return {
    applicationIncludedPaths,
    updaterIncludedPaths,
    activeHookMatches,
  };
}
