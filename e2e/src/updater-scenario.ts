import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Data } from 'effect';
import { getDefaultRunRoot } from './run-reliability';

export type NativeDialogResponse = {
  action: 'choose-stable-channel';
  response: number;
};

export type UpdaterRunDescriptor = {
  version: 1;
  scenario: 'updater-fixture-release';
  runId: string;
  sandboxDirectory: string;
  userDataDirectory: string;
  installationDirectory: string;
  artifactDirectory: string;
  fixtureStateDirectory: string;
  eventLogPath: string;
  nativeDialogLogPath: string;
  fixtureBaseUrl: string;
  releaseApiUrl: string;
  nativeDialogResponses: NativeDialogResponse[];
};

export type UpdaterScenarioLayout = Omit<
  UpdaterRunDescriptor,
  | 'version'
  | 'scenario'
  | 'fixtureBaseUrl'
  | 'releaseApiUrl'
  | 'nativeDialogResponses'
> & { descriptorPath: string };

export class UpdaterRunDescriptorValidationError extends Data.TaggedError(
  'UpdaterRunDescriptorValidationError'
)<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

export class FixtureServiceError extends Data.TaggedError(
  'FixtureServiceError'
)<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}

const require = createRequire(import.meta.url);
const { validateUpdaterRunDescriptor } =
  require('./updater-run-descriptor.cjs') as {
    validateUpdaterRunDescriptor(value: unknown): UpdaterRunDescriptor;
  };

export function parseUpdaterRunDescriptor(
  value: unknown
): UpdaterRunDescriptor {
  try {
    return validateUpdaterRunDescriptor(value);
  } catch (cause) {
    throw new UpdaterRunDescriptorValidationError({
      detail: (cause as Error).message,
    });
  }
}

export function readUpdaterRunDescriptor(path: string) {
  return parseUpdaterRunDescriptor(JSON.parse(readFileSync(path, 'utf8')));
}

export function createUpdaterScenarioSandbox(
  runId: string
): UpdaterScenarioLayout {
  const runRoot = getDefaultRunRoot();
  mkdirSync(runRoot, { recursive: true });
  const sandboxDirectory = mkdtempSync(join(runRoot, `updater-${runId}-`));
  const userDataDirectory = join(sandboxDirectory, 'user-data');
  const installationDirectory = join(sandboxDirectory, 'installation');
  const artifactDirectory = join(sandboxDirectory, 'artifacts');
  const fixtureStateDirectory = join(sandboxDirectory, 'fixture-state');
  const eventLogPath = join(sandboxDirectory, 'events.jsonl');
  const nativeDialogLogPath = join(
    artifactDirectory,
    'native-dialog-requests.jsonl'
  );
  const descriptorPath = join(sandboxDirectory, 'run-descriptor.json');
  for (const directory of [
    userDataDirectory,
    installationDirectory,
    artifactDirectory,
    fixtureStateDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    runId,
    sandboxDirectory,
    userDataDirectory,
    installationDirectory,
    artifactDirectory,
    fixtureStateDirectory,
    eventLogPath,
    nativeDialogLogPath,
    descriptorPath,
  };
}

export function writeUpdaterRunDescriptor(
  layout: UpdaterScenarioLayout,
  fixtureBaseUrl: string
) {
  const descriptor = parseUpdaterRunDescriptor({
    version: 1,
    scenario: 'updater-fixture-release',
    runId: layout.runId,
    sandboxDirectory: layout.sandboxDirectory,
    userDataDirectory: layout.userDataDirectory,
    installationDirectory: layout.installationDirectory,
    artifactDirectory: layout.artifactDirectory,
    fixtureStateDirectory: layout.fixtureStateDirectory,
    eventLogPath: layout.eventLogPath,
    nativeDialogLogPath: layout.nativeDialogLogPath,
    fixtureBaseUrl,
    releaseApiUrl: `${fixtureBaseUrl}/repos/Nat3z/OpenGameInstaller/releases`,
    nativeDialogResponses: [{ action: 'choose-stable-channel', response: 0 }],
  });
  writeFileSync(layout.descriptorPath, JSON.stringify(descriptor, null, 2));
  return { ...descriptor, descriptorPath: layout.descriptorPath };
}

export async function startFixtureService(fixtureStateDirectory: string) {
  mkdirSync(fixtureStateDirectory, { recursive: true });
  const requestLogPath = join(fixtureStateDirectory, 'requests.jsonl');
  writeFileSync(requestLogPath, '');
  const releases = [
    {
      tag_name: 'v9.9.9',
      prerelease: false,
      published_at: '2026-07-25T00:00:00.000Z',
      assets: [],
    },
  ];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const isReleaseRequest =
      request.method === 'GET' &&
      requestUrl.pathname === '/repos/Nat3z/OpenGameInstaller/releases';
    const status = isReleaseRequest ? 200 : 404;
    appendFileSync(
      requestLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        status,
      })}\n`
    );
    if (isReleaseRequest) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(releases));
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
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
  }).catch((cause) => {
    throw new FixtureServiceError({
      detail: 'Fixture Service failed to bind to loopback',
      cause,
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new FixtureServiceError({
      detail: 'Fixture Service did not allocate a TCP port',
    });
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requestLogPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function getUpdaterScenarioLaunch(platform: NodeJS.Platform) {
  if (platform === 'linux') {
    return {
      command: 'xvfb-run',
      args: ['-a', 'bunx', 'wdio', 'run', './updater-scenario-wdio.conf.ts'],
      detached: true,
    };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        './src/windows-job-wrapper.ps1',
        'bunx',
        'wdio',
        'run',
        './updater-scenario-wdio.conf.ts',
      ],
      detached: false,
    };
  }
  return {
    command: 'bunx',
    args: ['wdio', 'run', './updater-scenario-wdio.conf.ts'],
    detached: true,
  };
}
