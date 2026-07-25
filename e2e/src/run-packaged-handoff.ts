import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Exit } from 'effect';
import {
  buildPackagedHandoffArtifacts,
  copySyntheticOldInstallation,
  createPackagedHandoffSandbox,
  startPackagedHandoffFixture,
  verifyProductionPackagingBoundary,
  writePackagedHandoffRunDescriptor,
} from './packaged-handoff';
import { terminateProcessTree } from './process-tree';
import {
  makeRunEventWriter,
  renderRunHtmlReport,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate an automation port');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

function waitForProcess(child: ChildProcess) {
  return new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      rejectExit(
        new Error('Packaged Golden Journey did not finish within 5 minutes')
      );
    }, 300_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolveExit();
      } else {
        rejectExit(
          new Error(
            `Product Journey exited with status ${status} and signal ${signal}`
          )
        );
      }
    });
  });
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
const repositoryDirectory = resolve(e2eDirectory, '..');
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const runId = randomUUID();
const initialDescriptor = createPackagedHandoffSandbox(runId, platform);
const builds = buildPackagedHandoffArtifacts({
  outputDirectory: join(initialDescriptor.artifactDirectory, 'builds'),
  applicationBundleDirectory: join(repositoryDirectory, 'application/out'),
  applicationMainPath: join(
    repositoryDirectory,
    'application/e2e-product-main.cjs'
  ),
  fixtureServicePath: join(repositoryDirectory, 'e2e/fixture-service.cjs'),
  descriptorValidatorPath: join(
    repositoryDirectory,
    'e2e/src/packaged-handoff-run-descriptor.cjs'
  ),
  updaterBundleDirectory: join(repositoryDirectory, 'updater/dist'),
  updaterPublicDirectory: join(repositoryDirectory, 'updater/public'),
  updaterMainPath: join(
    repositoryDirectory,
    'updater/e2e-product-journey-main.cjs'
  ),
  fixtureAddonDirectory: join(repositoryDirectory, 'e2e/fixture-addon'),
  fixtureWebSocketModuleDirectory: join(repositoryDirectory, 'node_modules/ws'),
});
const currentBuild = builds.find((build) => build.platform === platform);
if (!currentBuild) throw new Error(`No ${platform} E2E artifact was built`);
rmSync(initialDescriptor.packagedUpdaterDirectory, {
  recursive: true,
  force: true,
});
cpSync(
  currentBuild.packagedUpdaterDirectory,
  initialDescriptor.packagedUpdaterDirectory,
  { recursive: true }
);
copySyntheticOldInstallation(
  currentBuild.syntheticOldInstallationDirectory,
  initialDescriptor.installationDirectory
);
mkdirSync(join(initialDescriptor.sandboxDirectory, 'downloads'), {
  recursive: true,
});
writeFileSync(
  join(initialDescriptor.fixtureStateDirectory, 'prerequisites.json'),
  JSON.stringify({ tools: 'available-in-sandbox', hostInstallRequired: false })
);
const fixture = await startPackagedHandoffFixture(
  initialDescriptor.fixtureStateDirectory,
  currentBuild.currentApplicationArtifactPath
);
const descriptor = writePackagedHandoffRunDescriptor(
  initialDescriptor,
  fixture.baseUrl,
  await allocateLoopbackPort(),
  await allocateLoopbackPort()
);
const optionDirectory = join(
  descriptor.applicationStateDirectory,
  'config/option'
);
mkdirSync(optionDirectory, { recursive: true });
writeFileSync(
  join(optionDirectory, 'developer.json'),
  JSON.stringify({
    clientSdkUrl: `ws://127.0.0.1:${descriptor.clientSdkPort}`,
  })
);
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, descriptor.runId);
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({
  type: 'scenario.started',
  payload: { scenarioId: descriptor.scenario, kind: 'Product Journey' },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId: descriptor.scenario, attempt: 1 },
});
writeEvent({
  type: 'fixture.started',
  payload: { port: Number(new URL(fixture.baseUrl).port) },
});

let child: ChildProcess | undefined;
let failure: unknown;
let leaked = false;
try {
  const command = platform === 'linux' ? 'xvfb-run' : 'powershell.exe';
  const args =
    platform === 'linux'
      ? ['-a', 'bunx', 'wdio', 'run', './product-journey-wdio.conf.ts']
      : [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          './src/windows-job-wrapper.ps1',
          'bunx',
          'wdio',
          'run',
          './product-journey-wdio.conf.ts',
        ];
  child = spawn(command, args, {
    cwd: e2eDirectory,
    detached: platform === 'linux',
    env: { ...process.env, OGI_RUN_DESCRIPTOR: descriptor.descriptorPath },
    stdio: 'inherit',
  });
  if (!child.pid) throw new Error('Product Journey process did not start');
  writeEvent({
    type: 'process.started',
    payload: { pid: child.pid, name: 'WebdriverIO Product Journey' },
  });
  await waitForProcess(child);
} catch (cause) {
  failure = cause;
} finally {
  if (child) {
    const cleanup = await Effect.runPromiseExit(terminateProcessTree(child));
    leaked = Exit.isFailure(cleanup);
    writeEvent = makeRunEventWriter(
      descriptor.eventLogPath,
      descriptor.runId,
      replayRunEventLog(descriptor.eventLogPath).lastSequence
    );
    writeEvent({
      type: 'process.stopped',
      payload: { pid: child.pid ?? 0, leaked },
    });
    if (leaked && !failure) failure = new Error('Product process tree leaked');
  }
  await fixture.close();
}

const requestLines = readFileSync(fixture.requestLogPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);
for (const line of requestLines) {
  const request = JSON.parse(line) as {
    method: string;
    path: string;
    status: number;
  };
  writeEvent({
    type: 'fixture.request',
    payload: {
      method: request.method,
      path: request.path,
      status: request.status,
    },
  });
}
writeEvent({
  type: 'fixture.stopped',
  payload: { requests: requestLines.length },
});
const artifacts = [
  [
    'main-log',
    join(descriptor.artifactDirectory, 'packaged-application-main.log'),
  ],
  [
    'renderer-log',
    join(descriptor.artifactDirectory, 'packaged-application-renderer.log'),
  ],
  [
    'updater-main-log',
    join(descriptor.artifactDirectory, 'packaged-updater-main.log'),
  ],
  [
    'updater-renderer-log',
    join(descriptor.artifactDirectory, 'packaged-updater-renderer.log'),
  ],
  ['fixture-requests', fixture.requestLogPath],
  ['handoff-log', descriptor.handoffLogPath],
  ['startup-health', descriptor.startupHealthPath],
  ['run-descriptor', descriptor.descriptorPath],
] as const;
for (const [artifactType, path] of artifacts) {
  if (existsSync(path)) {
    writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType,
        path: relative(descriptor.sandboxDirectory, path),
      },
    });
  }
}
const boundary = verifyProductionPackagingBoundary(repositoryDirectory);
writeFileSync(
  join(descriptor.artifactDirectory, 'production-package-boundary.json'),
  JSON.stringify(boundary, null, 2)
);
const outcome: TerminalOutcome = failure
  ? leaked
    ? 'Infrastructure Failed'
    : 'Failed'
  : 'Passed';
const htmlReportPath = join(descriptor.sandboxDirectory, 'report.html');
writeFileSync(
  htmlReportPath,
  renderRunHtmlReport(descriptor.eventLogPath, outcome)
);
writeEvent({
  type: 'artifact.created',
  payload: {
    artifactType: 'html-report',
    path: relative(descriptor.sandboxDirectory, htmlReportPath),
  },
});
writeEvent({
  type: 'attempt.completed',
  payload: { attempt: 1, outcome },
});
writeEvent({
  type: 'scenario.completed',
  payload: { scenarioId: descriptor.scenario, outcome },
});
writeEvent({ type: 'run.completed', payload: { outcome } });
writeFileSync(
  join(descriptor.sandboxDirectory, 'summary.json'),
  JSON.stringify(replayRunEventLog(descriptor.eventLogPath), null, 2)
);
console.log(`Run Event Log: ${descriptor.eventLogPath}`);
console.log(`Scenario Sandbox: ${descriptor.sandboxDirectory}`);
if (failure) {
  throw failure;
}
