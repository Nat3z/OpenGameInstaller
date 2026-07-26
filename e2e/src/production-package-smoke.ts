import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { terminatePidTree } from './process-tree';

const require = createRequire(import.meta.url);

function appBuilderExecutable() {
  const value = require('app-builder-bin') as { appBuilderPath?: unknown };
  if (typeof value.appBuilderPath !== 'string') {
    throw new Error('Unable to resolve app-builder for blockmap validation');
  }
  return value.appBuilderPath;
}

export type ProductionReleaseArtifacts = {
  applicationArtifact: string;
  updaterArtifact: string;
  applicationBlockmap: string;
  updaterBlockmap: string;
  applicationKind: 'appimage' | 'portable-zip';
  updaterKind: 'appimage' | 'nsis-installer';
};

function requireArtifact(path: string) {
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    statSync(path).size === 0
  ) {
    throw new Error(`Production release artifact is missing or empty: ${path}`);
  }
  return path;
}

function requireMatchingBlockmap(artifactPath: string) {
  const blockmapPath = `${artifactPath}.blockmap`;
  if (
    !existsSync(blockmapPath) ||
    !statSync(blockmapPath).isFile() ||
    statSync(blockmapPath).size === 0
  ) {
    throw new Error(
      `Publication blockmap is missing or empty: ${blockmapPath}`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(readFileSync(blockmapPath)).toString('utf8'));
  } catch (cause) {
    throw new Error(
      `Publication artifact has an invalid blockmap: ${blockmapPath}`,
      {
        cause,
      }
    );
  }
  const file =
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { files?: unknown }).files)
      ? (value as { files: unknown[] }).files[0]
      : undefined;
  const record =
    typeof file === 'object' && file !== null
      ? (file as Record<string, unknown>)
      : undefined;
  const sizes = record?.sizes;
  const checksums = record?.checksums;
  const offset = record?.offset ?? 0;
  if (
    !Array.isArray(sizes) ||
    !Array.isArray(checksums) ||
    sizes.length === 0 ||
    sizes.length !== checksums.length ||
    sizes.some((size) => !Number.isInteger(size) || Number(size) < 1) ||
    checksums.some(
      (checksum) => typeof checksum !== 'string' || checksum.length === 0
    ) ||
    !Number.isInteger(offset) ||
    Number(offset) < 0
  ) {
    throw new Error(
      `Publication artifact has an invalid blockmap: ${blockmapPath}`
    );
  }
  const describedSize =
    Number(offset) + sizes.reduce((total, size) => total + Number(size), 0);
  if (describedSize !== statSync(artifactPath).size) {
    throw new Error(
      `Publication blockmap does not match artifact: ${blockmapPath}`
    );
  }

  const validationDirectory = mkdtempSync(
    join(tmpdir(), 'production-blockmap-validation-')
  );
  const regeneratedPath = join(validationDirectory, basename(blockmapPath));
  try {
    const regeneration = spawnSync(
      appBuilderExecutable(),
      ['blockmap', '--input', artifactPath, '--output', regeneratedPath],
      { encoding: 'utf8', timeout: 120_000 }
    );
    if (regeneration.error || regeneration.status !== 0) {
      throw new Error(
        `Could not regenerate publication blockmap: ${regeneration.stderr ?? ''}${regeneration.error?.message ?? ''}`
      );
    }
    const regenerated = JSON.parse(
      gunzipSync(readFileSync(regeneratedPath)).toString('utf8')
    );
    if (JSON.stringify(regenerated) !== JSON.stringify(value)) {
      throw new Error(
        `Publication blockmap does not match artifact: ${blockmapPath}`
      );
    }
  } finally {
    rmSync(validationDirectory, { recursive: true, force: true });
  }
  return blockmapPath;
}

export function findProductionReleaseArtifacts(
  artifactDirectory: string,
  platform: NodeJS.Platform
): ProductionReleaseArtifacts {
  const root = resolve(artifactDirectory);
  if (platform === 'linux') {
    return {
      applicationArtifact: requireArtifact(
        join(root, 'OpenGameInstaller-linux-pt.AppImage')
      ),
      updaterArtifact: requireArtifact(
        join(root, 'OpenGameInstaller-Setup.AppImage')
      ),
      applicationBlockmap: requireMatchingBlockmap(
        join(root, 'OpenGameInstaller-linux-pt.AppImage')
      ),
      updaterBlockmap: requireMatchingBlockmap(
        join(root, 'OpenGameInstaller-Setup.AppImage')
      ),
      applicationKind: 'appimage',
      updaterKind: 'appimage',
    };
  }
  if (platform === 'win32') {
    return {
      applicationArtifact: requireArtifact(
        join(root, 'OpenGameInstaller-Portable.zip')
      ),
      updaterArtifact: requireArtifact(
        join(root, 'OpenGameInstaller-Setup.exe')
      ),
      applicationBlockmap: requireMatchingBlockmap(
        join(root, 'OpenGameInstaller-Portable.zip')
      ),
      updaterBlockmap: requireMatchingBlockmap(
        join(root, 'OpenGameInstaller-Setup.exe')
      ),
      applicationKind: 'portable-zip',
      updaterKind: 'nsis-installer',
    };
  }
  throw new Error(
    `Production release artifact smoke is unsupported on ${platform}`
  );
}

const activeHookMarkers = [
  Buffer.from('OGI_RUN_DESCRIPTOR'),
  Buffer.from('packaged-updater-application-handoff'),
];
const scannedExtensions = new Set([
  '.asar',
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.ts',
]);

function extension(path: string) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot);
}

function containsActiveHook(path: string) {
  const descriptor = openSync(path, 'r');
  const longestMarker = Math.max(
    ...activeHookMarkers.map((marker) => marker.length)
  );
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) return false;
      const contents = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (activeHookMarkers.some((marker) => contents.includes(marker))) {
        return true;
      }
      carry = contents.subarray(
        Math.max(0, contents.length - longestMarker + 1)
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

export function verifyExtractedProductionBoundary(extractedRoot: string) {
  const root = resolve(extractedRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Extracted production package is missing: ${root}`);
  }
  const activeHookMatches: string[] = [];
  let scannedFiles = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        scannedExtensions.has(extension(entry.name))
      ) {
        scannedFiles += 1;
        if (containsActiveHook(path)) {
          activeHookMatches.push(relative(root, path));
        }
      }
    }
  };
  visit(root);
  if (scannedFiles === 0) {
    throw new Error(
      `Extracted production package contains no scannable resources: ${root}`
    );
  }
  if (activeHookMatches.length > 0) {
    throw new Error(
      `Extracted production package contains an active E2E hook: ${activeHookMatches.join(', ')}`
    );
  }
  return { scannedFiles, activeHookMatches };
}

function runChecked(
  command: string,
  arguments_: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    killSignal: 'SIGTERM',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Production artifact command failed: ${command} ${arguments_.join(' ')}\n${result.stderr ?? ''}${result.error?.message ?? ''}`
    );
  }
  return result;
}

function findNamedFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return path;
    }
  }
  return undefined;
}

async function reservePort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(
          new Error('Could not reserve a production smoke readiness port')
        );
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });
}

async function waitForElectronReadiness(
  port: number,
  child: ReturnType<typeof spawn>,
  timeoutMs = 30_000,
  readinessSignal: () => boolean = () => false,
  launchError: () => unknown = () => undefined
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnFailure = launchError();
    if (spawnFailure) {
      throw new Error('Production artifact process failed to spawn', {
        cause: spawnFailure,
      });
    }
    if (readinessSignal()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Production artifact exited before readiness (code ${child.exitCode}, signal ${child.signalCode})`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Chromium has not opened the debugging endpoint yet.
    }
    await Bun.sleep(250);
  }
  throw new Error('Production artifact did not become ready within 30 seconds');
}

export function productionArtifactLaunchArguments(
  product: 'application' | 'updater',
  port: number
) {
  return [
    product === 'application' ? '--online=false' : '--gui',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--metrics-recording-only',
  ];
}

type WindowsFirewallLifecycleOptions<T> = {
  executable: string;
  ruleName: string;
  evidencePath: string;
  environment?: NodeJS.ProcessEnv;
  runPowerShell?: (script: string) => void;
  action: () => T | Promise<T>;
};

export async function withWindowsOutboundFirewall<T>({
  executable,
  ruleName,
  evidencePath,
  environment = process.env,
  runPowerShell = (script) =>
    runChecked(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: environment }
    ),
  action,
}: WindowsFirewallLifecycleOptions<T>): Promise<T> {
  const escapedRule = ruleName.replaceAll("'", "''");
  const escapedExecutable = executable.replaceAll("'", "''");
  const entries: Array<Record<string, unknown>> = [];
  const record = (phase: string, expected: boolean, error?: unknown) => {
    entries.push({
      version: 1,
      transport: 'guard-install',
      phase,
      target: ruleName,
      executable,
      expected,
      ...(error
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    });
    writeFileSync(
      evidencePath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    );
  };

  let ruleSetupAttempted = false;
  let ruleCreated = false;
  let value: T | undefined;
  let lifecycleError: unknown;
  let cleanupError: unknown;
  try {
    ruleSetupAttempted = true;
    runPowerShell(
      `New-NetFirewallRule -DisplayName '${escapedRule}' -Direction Outbound -Program '${escapedExecutable}' -Action Block -ErrorAction Stop | Out-Null`
    );
    ruleCreated = true;
    runPowerShell(
      `if (-not (Get-NetFirewallRule -DisplayName '${escapedRule}' -ErrorAction SilentlyContinue)) { throw 'firewall rule must exist before process execution' }`
    );
    record('installed', true);
    try {
      value = await action();
    } catch (cause) {
      lifecycleError = cause;
      record('action-failed', false, cause);
    }
  } catch (cause) {
    lifecycleError = cause;
    record(
      ruleCreated ? 'verification-failed' : 'installation-failed',
      false,
      cause
    );
  } finally {
    if (ruleSetupAttempted) {
      try {
        runPowerShell(
          `Get-NetFirewallRule -DisplayName '${escapedRule}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop`
        );
        runPowerShell(
          `if (Get-NetFirewallRule -DisplayName '${escapedRule}' -ErrorAction SilentlyContinue) { throw 'firewall rule must be absent after process execution' }`
        );
        record('removed', true);
      } catch (cause) {
        cleanupError = cause;
        record('removal-failed', false, cause);
      }
    }
  }

  if (lifecycleError && cleanupError) {
    throw new AggregateError(
      [lifecycleError, cleanupError],
      'Windows outbound firewall lifecycle failed'
    );
  }
  if (cleanupError) {
    throw new Error('Windows outbound firewall lifecycle failed', {
      cause: cleanupError,
    });
  }
  if (lifecycleError) throw lifecycleError;
  return value as T;
}

type WindowsNsisInstallationOptions = {
  installerPath: string;
  installationDirectory: string;
  evidencePath: string;
  ruleName: string;
  environment?: NodeJS.ProcessEnv;
  runPowerShell?: (script: string) => void;
  runInstaller?: () => void;
};

export async function installWindowsNsisArtifact({
  installerPath,
  installationDirectory,
  evidencePath,
  ruleName,
  environment = process.env,
  runPowerShell,
  runInstaller = () =>
    runChecked(installerPath, ['/S', `/D=${installationDirectory}`], {
      env: environment,
      timeout: 120_000,
    }),
}: WindowsNsisInstallationOptions) {
  await withWindowsOutboundFirewall({
    executable: installerPath,
    ruleName,
    evidencePath,
    environment,
    ...(runPowerShell ? { runPowerShell } : {}),
    action: runInstaller,
  });
  return assertProductionTrafficAudit([evidencePath])[0]!;
}

export function assertProductionTrafficAudit(logPaths: readonly string[]) {
  return logPaths.map((path) => {
    if (!existsSync(path)) {
      throw new Error(`Production traffic audit is missing: ${path}`);
    }
    let entries: Array<Record<string, unknown>>;
    try {
      entries = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (cause) {
      throw new Error(`Production traffic audit is malformed: ${path}`, {
        cause,
      });
    }
    if (!entries.some((entry) => entry.transport === 'guard-install')) {
      throw new Error(
        `Production traffic denial guard was not installed: ${path}`
      );
    }
    const unexpected = entries.filter((entry) => entry.expected !== true);
    if (unexpected.length > 0) {
      throw new Error(
        `Production artifact attempted unexpected public traffic: ${JSON.stringify(unexpected)}`
      );
    }
    return { path, entries };
  });
}

function writeLinuxTrafficAudit(
  tracePrefix: string,
  trafficLogPath: string,
  label: 'application' | 'updater'
) {
  const entries: Array<Record<string, unknown>> = [
    {
      transport: 'guard-install',
      target: 'isolated-network-namespace',
      product: label,
      expected: true,
    },
  ];
  for (const name of readdirSync(resolve(tracePrefix, '..'))) {
    if (!name.startsWith(`${basename(tracePrefix)}.`)) continue;
    for (const line of readFileSync(
      join(resolve(tracePrefix, '..'), name),
      'utf8'
    ).split(/\r?\n/)) {
      if (!line.includes('connect(')) continue;
      const targets = [
        ...line.matchAll(/inet_addr\("([^"]+)"\)/g),
        ...line.matchAll(/inet_pton\(AF_INET6, "([^"]+)"/g),
      ].map((match) => match[1]!);
      for (const target of targets) {
        entries.push({
          transport: 'process-connect',
          target,
          product: label,
          expected:
            label === 'updater' && (target === '::1' || target === '127.0.0.1'),
        });
      }
    }
  }
  writeFileSync(
    trafficLogPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  );
}

async function launchAndStop(
  executable: string,
  environment: NodeJS.ProcessEnv,
  evidenceDirectory: string,
  label: 'application' | 'updater'
) {
  const port = await reservePort();
  const stdoutPath = join(evidenceDirectory, `${label}-stdout.log`);
  const stderrPath = join(evidenceDirectory, `${label}-stderr.log`);
  const stdout = Bun.file(stdoutPath).writer();
  const stderr = Bun.file(stderrPath).writer();
  const useXvfb =
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0;
  const baseCommand = useXvfb ? 'xvfb-run' : executable;
  const baseArguments = [
    ...(useXvfb ? ['-a', executable] : []),
    ...productionArtifactLaunchArguments(label, port),
  ];
  const trafficLogPath = join(evidenceDirectory, `${label}-traffic.jsonl`);
  const tracePrefix = join(evidenceDirectory, `${label}-network.strace`);
  let command = baseCommand;
  let arguments_ = baseArguments;
  let firewallRuleName: string | undefined;
  if (process.platform === 'linux') {
    for (const dependency of ['bwrap', 'strace']) {
      if (spawnSync('which', [dependency], { stdio: 'ignore' }).status !== 0) {
        throw new Error(
          `Production traffic isolation requires ${dependency} on Linux`
        );
      }
    }
    command = 'strace';
    arguments_ = [
      '-ff',
      '-e',
      'trace=network',
      '-o',
      tracePrefix,
      'bwrap',
      '--unshare-net',
      '--dev-bind',
      '/',
      '/',
      '--ro-bind',
      '/dev/null',
      '/etc/resolv.conf',
      '--',
      baseCommand,
      ...baseArguments,
    ];
  } else if (process.platform === 'win32') {
    firewallRuleName = `OGI production smoke ${label} ${process.pid} ${Date.now()}`;
  }
  const launchEnvironment = {
    ...environment,
    ...(basename(executable) === 'AppRun'
      ? { APPDIR: resolve(executable, '..') }
      : {}),
    ...(process.platform === 'linux' ? { RES_OPTIONS: 'attempts:0' } : {}),
  };
  const executeLaunch = async () => {
    const child = spawn(command, arguments_, {
      cwd: environment.HOME,
      env: launchEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform === 'linux',
    });
    let stderrContents = '';
    let spawnError: unknown;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.stdout?.on('data', (chunk) => stdout.write(chunk));
    child.stderr?.on('data', (chunk) => {
      stderr.write(chunk);
      stderrContents = `${stderrContents}${String(chunk)}`.slice(-4096);
    });
    try {
      await waitForElectronReadiness(
        port,
        child,
        30_000,
        () =>
          process.platform === 'linux' &&
          stderrContents.includes('DevTools listening on'),
        () => spawnError
      );
    } finally {
      if (child.pid) {
        if (process.platform === 'linux') {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // The isolated process group already exited.
          }
          await Bun.sleep(500);
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The isolated process group exited after SIGTERM.
          }
        } else {
          await terminatePidTree(child.pid);
        }
      }
    }
  };
  try {
    if (firewallRuleName) {
      await withWindowsOutboundFirewall({
        executable,
        ruleName: firewallRuleName,
        evidencePath: trafficLogPath,
        environment,
        action: executeLaunch,
      });
    } else {
      await executeLaunch();
    }
  } finally {
    await Promise.all([stdout.end(), stderr.end()]);
  }
  if (process.platform === 'linux') {
    writeLinuxTrafficAudit(tracePrefix, trafficLogPath, label);
  }
  const [trafficAudit] = assertProductionTrafficAudit([trafficLogPath]);
  return {
    executable,
    readinessPort: port,
    stdoutPath,
    stderrPath,
    trafficAudit,
  };
}

export async function runProductionPackageSmoke(
  artifactDirectory: string,
  outputDirectory: string,
  platform: NodeJS.Platform = process.platform
) {
  const artifacts = findProductionReleaseArtifacts(artifactDirectory, platform);
  mkdirSync(outputDirectory, { recursive: true });
  const stateRoot = mkdtempSync(join(tmpdir(), 'production-smoke-state-'));
  const environment = {
    ...process.env,
    HOME: join(stateRoot, 'home'),
    XDG_CONFIG_HOME: join(stateRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(stateRoot, 'xdg-cache'),
    XDG_DATA_HOME: join(stateRoot, 'xdg-data'),
    APPDATA: join(stateRoot, 'appdata'),
    LOCALAPPDATA: join(stateRoot, 'localappdata'),
    OGI_E2E_DETERMINISTIC_ONLY: '1',
  };
  for (const directory of Object.values(environment).filter(
    (value): value is string =>
      typeof value === 'string' && value.startsWith(stateRoot)
  )) {
    mkdirSync(directory, { recursive: true });
  }

  let applicationExecutable: string;
  let updaterExecutable: string;
  let applicationBoundary: ReturnType<typeof verifyExtractedProductionBoundary>;
  let updaterBoundary: ReturnType<typeof verifyExtractedProductionBoundary>;
  let updaterInstallationTraffic:
    | ReturnType<typeof assertProductionTrafficAudit>[number]
    | undefined;
  if (platform === 'linux') {
    chmodSync(artifacts.applicationArtifact, 0o755);
    chmodSync(artifacts.updaterArtifact, 0o755);
    const applicationExtracted = join(outputDirectory, 'application-extracted');
    const updaterExtracted = join(outputDirectory, 'updater-extracted');
    mkdirSync(applicationExtracted, { recursive: true });
    mkdirSync(updaterExtracted, { recursive: true });
    runChecked(artifacts.applicationArtifact, ['--appimage-extract'], {
      cwd: applicationExtracted,
      env: environment,
    });
    runChecked(artifacts.updaterArtifact, ['--appimage-extract'], {
      cwd: updaterExtracted,
      env: environment,
    });
    applicationBoundary = verifyExtractedProductionBoundary(
      join(applicationExtracted, 'squashfs-root')
    );
    updaterBoundary = verifyExtractedProductionBoundary(
      join(updaterExtracted, 'squashfs-root')
    );
    applicationExecutable = join(
      applicationExtracted,
      'squashfs-root',
      'AppRun'
    );
    updaterExecutable = join(updaterExtracted, 'squashfs-root', 'AppRun');
    requireArtifact(applicationExecutable);
    requireArtifact(updaterExecutable);
  } else if (platform === 'win32') {
    const portableExtracted = join(outputDirectory, 'application-extracted');
    mkdirSync(portableExtracted, { recursive: true });
    runChecked(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${artifacts.applicationArtifact.replaceAll("'", "''")}' -DestinationPath '${portableExtracted.replaceAll("'", "''")}' -Force`,
      ],
      { env: environment }
    );
    applicationExecutable =
      findNamedFile(portableExtracted, 'OpenGameInstaller.exe') ?? '';
    if (!applicationExecutable) {
      throw new Error('Windows portable artifact has no OpenGameInstaller.exe');
    }
    applicationBoundary = verifyExtractedProductionBoundary(portableExtracted);
    const updaterInstallation = join(stateRoot, 'installed-updater');
    mkdirSync(updaterInstallation, { recursive: true });
    const installerTrafficPath = join(
      outputDirectory,
      'updater-installer-traffic.jsonl'
    );
    updaterInstallationTraffic = await installWindowsNsisArtifact({
      installerPath: artifacts.updaterArtifact,
      installationDirectory: updaterInstallation,
      ruleName: `OGI production smoke updater installer ${process.pid} ${Date.now()}`,
      evidencePath: installerTrafficPath,
      environment,
    });
    updaterExecutable =
      findNamedFile(updaterInstallation, 'OpenGameInstaller.exe') ?? '';
    if (!updaterExecutable) {
      throw new Error('NSIS artifact did not install OpenGameInstaller.exe');
    }
    updaterBoundary = verifyExtractedProductionBoundary(
      resolve(updaterExecutable, '..')
    );
  } else {
    throw new Error(`Production package smoke is unsupported on ${platform}`);
  }

  const applicationLaunch = await launchAndStop(
    applicationExecutable,
    environment,
    outputDirectory,
    'application'
  );
  const updaterLaunch = await launchAndStop(
    updaterExecutable,
    environment,
    outputDirectory,
    'updater'
  );
  const report = {
    version: 1,
    platform,
    artifacts: {
      application: basename(artifacts.applicationArtifact),
      updater: basename(artifacts.updaterArtifact),
      applicationBlockmap: basename(artifacts.applicationBlockmap),
      updaterBlockmap: basename(artifacts.updaterBlockmap),
    },
    boundaries: { application: applicationBoundary, updater: updaterBoundary },
    installations: {
      ...(updaterInstallationTraffic
        ? { updater: updaterInstallationTraffic }
        : {}),
    },
    launches: { application: applicationLaunch, updater: updaterLaunch },
    outcome: 'Passed',
  };
  writeFileSync(
    join(outputDirectory, 'production-package-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  return report;
}
