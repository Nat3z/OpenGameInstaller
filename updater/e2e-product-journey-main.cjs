const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const {
  validatePackagedHandoffRunDescriptor,
} = require('./support/packaged-handoff-run-descriptor.cjs');
const {
  descendantGuardEnvironment,
  installOfflineTrafficGuard,
} = require('./support/offline-traffic-guard.cjs');
const updateEnginePromise = import('./support/update-engine.mjs');
const productionCoordinatorPromise = import(
  './support/production-update-coordinator.mjs'
);

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the Product Journey');
}
const descriptor = validatePackagedHandoffRunDescriptor(
  JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
);
const updaterDirectory = __dirname;
const mainLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-updater-main.log'
);
const rendererLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-updater-renderer.log'
);
fs.mkdirSync(descriptor.artifactDirectory, { recursive: true });
fs.mkdirSync(descriptor.updaterUserDataDirectory, { recursive: true });
app.setPath('userData', descriptor.updaterUserDataDirectory);

function appendHandoff(value) {
  fs.appendFileSync(
    descriptor.handoffLogPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`
  );
}

function logMain(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  fs.appendFileSync(mainLogPath, `${message}${suffix}\n`);
  console.log(message, details ?? '');
}

function containedPath(root, candidate) {
  const destination = path.resolve(root, candidate);
  const fromRoot = path.relative(path.resolve(root), destination);
  if (
    fromRoot === '' ||
    fromRoot.startsWith('..') ||
    path.isAbsolute(fromRoot)
  ) {
    throw new Error(`Candidate path is unsafe: ${candidate}`);
  }
  return destination;
}

function materializeArtifact(artifact) {
  if (
    artifact.formatVersion !== 1 ||
    artifact.platform !== descriptor.platform ||
    artifact.version !== 'v4.1.0-e2e' ||
    artifact.entryPoint !== 'app/e2e-product-main.cjs' ||
    artifact.executable !==
      (descriptor.platform === 'win32'
        ? 'OpenGameInstaller.exe'
        : 'OpenGameInstaller.AppImage') ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('Packaged application artifact is invalid');
  }
  const validatedFiles = artifact.files.map((file) => {
    if (
      typeof file?.path !== 'string' ||
      typeof file.contents !== 'string' ||
      !Number.isInteger(file.mode)
    ) {
      throw new Error('Packaged application file entry is invalid');
    }
    return {
      ...file,
      destination: containedPath(descriptor.stagingDirectory, file.path),
    };
  });
  containedPath(descriptor.stagingDirectory, artifact.executable);
  const artifactPaths = new Set(validatedFiles.map((file) => file.path));
  const requiredPaths = [
    artifact.entryPoint,
    'app/out/preload/index.mjs',
    'app/out/renderer/index.html',
    'support/fixture-service.cjs',
    'support/packaged-handoff-run-descriptor.cjs',
    artifact.executable,
  ];
  const missingRequiredPath = requiredPaths.find(
    (requiredPath) => !artifactPaths.has(requiredPath)
  );
  if (missingRequiredPath) {
    throw new Error(
      `Packaged application artifact is missing required file: ${missingRequiredPath}`
    );
  }
  fs.rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(descriptor.stagingDirectory, { recursive: true });
  try {
    for (const file of validatedFiles) {
      fs.mkdirSync(path.dirname(file.destination), { recursive: true });
      fs.writeFileSync(file.destination, Buffer.from(file.contents, 'base64'));
      fs.chmodSync(file.destination, file.mode);
    }
    fs.writeFileSync(
      path.join(descriptor.stagingDirectory, 'version.txt'),
      artifact.version
    );
    return artifact.entryPoint;
  } catch (error) {
    fs.rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function waitForStartupHealth(recovery = false, transactionToken) {
  const deadline = Date.now() + descriptor.healthTimeoutMs * (recovery ? 2 : 1);
  while (Date.now() < deadline) {
    if (
      candidateApplication &&
      (candidateApplication.exitCode !== null ||
        candidateApplication.signalCode !== null)
    ) {
      throw new Error(
        `Candidate application exited before Startup Health with status ${candidateApplication.exitCode} and signal ${candidateApplication.signalCode}`
      );
    }
    if (fs.existsSync(descriptor.startupHealthPath)) {
      const health = JSON.parse(
        fs.readFileSync(descriptor.startupHealthPath, 'utf8')
      );
      if (
        health.version === 1 &&
        health.runId === descriptor.runId &&
        health.state === 'interactive' &&
        health.processAlive === true &&
        health.transactionToken === transactionToken &&
        (recovery
          ? health.recovery === true
          : health.lastKnownGoodPresent === true)
      ) {
        return health;
      }
      throw new Error('Startup Health Signal is invalid');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Startup Health Signal did not arrive before the deadline');
}

let candidateApplication;

function fixtureProcessIdIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function readFixtureProcessIdentity(pid) {
  if (!fixtureProcessIdIsAlive(pid)) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const environment = fs
        .readFileSync(`/proc/${pid}/environ`)
        .toString('utf8')
        .split('\0');
      let token = environment
        .find((variable) =>
          variable.startsWith('OGI_UPDATE_TRANSACTION_TOKEN=')
        )
        ?.slice('OGI_UPDATE_TRANSACTION_TOKEN='.length);
      let proofBound = false;
      for (const descriptor of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
          if (
            !fs.readlinkSync(descriptorPath).includes('.ogi-process-proof-')
          ) {
            continue;
          }
          const value = fs.readFileSync(descriptorPath, 'utf8');
          if (/^[0-9a-f-]{36}$/i.test(value)) {
            token = value;
            proofBound = true;
            break;
          }
        } catch {}
      }
      if (!fields[19] || !token) return null;
      return {
        pid,
        startTime: fields[19],
        executable: fs.readlinkSync(`/proc/${pid}/exe`),
        transactionToken: token,
        proofBound,
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
      throw error;
    }
  }
  if (!candidateApplication || candidateApplication.pid !== pid) return null;
  const token = candidateApplication.spawnargs
    .find((argument) => argument.startsWith('--ogi-update-transaction-token='))
    ?.slice('--ogi-update-transaction-token='.length);
  if (!token) return null;
  return {
    pid,
    startTime: String(candidateApplication.__ogiStartTime),
    executable: path.resolve(process.execPath),
    transactionToken: token,
  };
}

function fixtureIdentitiesMatch(expected, actual) {
  return (
    expected.pid === actual?.pid &&
    expected.startTime === actual.startTime &&
    path.resolve(expected.executable) === path.resolve(actual.executable) &&
    expected.transactionToken === actual.transactionToken
  );
}

async function discoverFixtureProcesses(launchIntent) {
  if (!candidateApplication?.pid) return [];
  const identity = await readFixtureProcessIdentity(candidateApplication.pid);
  if (
    !identity ||
    identity.transactionToken !== launchIntent.transactionToken ||
    (path.resolve(identity.executable) !==
      path.resolve(launchIntent.executable) &&
      !(
        launchIntent.allowProofBoundExecTransition === true &&
        identity.proofBound === true
      ))
  ) {
    return [];
  }
  return [identity];
}

function resolveFixtureLaunchExecutable() {
  const executable =
    process.platform === 'linux'
      ? descriptor.applicationLauncherPath
      : process.execPath;
  return {
    executable: path.resolve(executable),
    launcherDigest: createHash('sha256')
      .update(fs.readFileSync(executable))
      .digest('hex'),
    allowProofBoundExecTransition: process.platform === 'linux',
  };
}

async function fixtureProcessIsAlive(identity) {
  const actual = await readFixtureProcessIdentity(identity.pid);
  return Boolean(actual && fixtureIdentitiesMatch(identity, actual));
}

async function terminateFixtureOwnedProcess(identity) {
  if (!candidateApplication || candidateApplication.pid !== identity.pid) {
    throw new Error('Owned fixture process handle is unavailable');
  }
  if (process.platform !== 'linux') {
    const actual = await readFixtureProcessIdentity(identity.pid);
    if (!fixtureIdentitiesMatch(identity, actual)) {
      throw new Error(
        'Owned fixture process identity changed before termination'
      );
    }
    const result = await stopCandidateApplication();
    return { ...result, processTreeStopped: true };
  }
  const script = `
import os, select, signal, sys, time
root = int(sys.argv[1])
expected_start, expected_exe, expected_token = sys.argv[2:5]
def token_claimed(pid):
 try:
  environment = open(f'/proc/{pid}/environ', 'rb').read().split(b'\\0')
  command = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\\0')
 except (FileNotFoundError, ProcessLookupError): return False
 except OSError: return False
 token = expected_token.encode()
 return b'OGI_UPDATE_TRANSACTION_TOKEN=' + token in environment or b'--ogi-update-transaction-token=' + token in command
def proof_bound(pid):
 try: descriptors = os.listdir(f'/proc/{pid}/fd')
 except FileNotFoundError: return False
 except OSError as error:
  if token_claimed(pid): raise RuntimeError(f'uninspectable proof-bearing process {pid}: {error}')
  return False
 for descriptor in descriptors:
  descriptor_path = f'/proc/{pid}/fd/{descriptor}'
  try: target = os.readlink(descriptor_path)
  except FileNotFoundError: continue
  except OSError as error:
   if token_claimed(pid): raise RuntimeError(f'uninspectable proof-bearing descriptor {pid}/{descriptor}: {error}')
   continue
  if '.ogi-process-proof-' not in target: continue
  try:
   with open(descriptor_path, encoding='utf-8') as proof: value = proof.read()
  except FileNotFoundError: continue
  except (OSError, UnicodeError) as error:
   if token_claimed(pid): raise RuntimeError(f'malformed proof descriptor {pid}/{descriptor}: {error}')
   continue
  if value == expected_token: return True
 return False
def scan():
 return [int(entry) for entry in os.listdir('/proc') if entry.isdigit() and proof_bound(int(entry))]
root_exists = os.path.exists(f'/proc/{root}')
if root_exists:
 try:
  stat = open(f'/proc/{root}/stat', encoding='utf-8').read()
  fields = stat[stat.rfind(')') + 2:].split(' ')
  actual_exe = os.readlink(f'/proc/{root}/exe')
 except (FileNotFoundError, ProcessLookupError): root_exists = False
 if root_exists and (fields[19] != expected_start or os.path.realpath(actual_exe) != os.path.realpath(expected_exe) or not proof_bound(root)):
  print('identity mismatch before pidfd tree termination', file=sys.stderr); sys.exit(4)
try:
 if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'): raise RuntimeError('pidfd APIs unavailable')
 deadline = time.monotonic() + 10
 all_pids, stable_zero = set(), 0
 while time.monotonic() < deadline:
  handles, frozen_pids, stable_discovery = {}, set(), 0
  try:
   while time.monotonic() < deadline and stable_discovery < 3:
    discovered = set(scan())
    new_pids = discovered - frozen_pids
    if not new_pids:
     stable_discovery += 1
     time.sleep(0.02)
     continue
    stable_discovery = 0
    for pid in sorted(new_pids):
     try:
      handle = os.pidfd_open(pid, 0)
      signal.pidfd_send_signal(handle, signal.SIGSTOP)
      handles[pid] = handle
      frozen_pids.add(pid)
      all_pids.add(pid)
     except ProcessLookupError: pass
   if not handles:
    stable_zero += 1
    if stable_zero >= 3:
     print(','.join(str(pid) for pid in sorted(all_pids)), flush=True)
     sys.exit(3 if not all_pids and not root_exists else 0)
    time.sleep(0.05)
    continue
   stable_zero = 0
   for handle in reversed(list(handles.values())):
    try: signal.pidfd_send_signal(handle, signal.SIGTERM)
    except ProcessLookupError: pass
   poller = select.poll()
   for handle in handles.values(): poller.register(handle, select.POLLIN)
   terminated_handles = {handle for handle, _ in poller.poll(500)}
   for handle in handles.values():
    if handle not in terminated_handles:
     try: signal.pidfd_send_signal(handle, signal.SIGKILL)
     except ProcessLookupError: pass
   poller.poll(1000)
  finally:
   for handle in handles.values(): os.close(handle)
 raise RuntimeError('proof-bound process tree did not reach stable zero')
except (AttributeError, OSError, RuntimeError) as error:
 print(f'pidfd tree termination failed: {error}', file=sys.stderr); sys.exit(5)
`;
  const result = await new Promise((resolve, reject) => {
    const helper = spawn(
      'python3',
      [
        '-c',
        script,
        String(identity.pid),
        identity.startTime,
        identity.executable,
        identity.transactionToken,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    helper.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    helper.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    helper.once('error', reject);
    helper.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code === 0 || result.code === 3) {
    const terminatedPids = result.stdout
      .trim()
      .split(',')
      .filter(Boolean)
      .map(Number);
    appendHandoff({
      phase: 'owned-process-tree-terminated',
      rootPid: identity.pid,
      terminatedPids,
      processTreeStopped: true,
    });
    return {
      processStopped: true,
      processExited: result.code === 3,
      processTreeStopped: true,
    };
  }
  throw new Error(
    `Fixture pidfd identity-handle termination failed: ${result.stderr || `exit ${result.code}`}`
  );
}

async function stopCandidateApplication() {
  if (
    !candidateApplication ||
    candidateApplication.exitCode !== null ||
    candidateApplication.signalCode !== null
  )
    return { processStopped: true };
  candidateApplication.kill();
  await Promise.race([
    new Promise((resolve) => candidateApplication.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (
    candidateApplication.exitCode === null &&
    candidateApplication.signalCode === null
  ) {
    candidateApplication.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => candidateApplication.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  const processStopped =
    candidateApplication.exitCode !== null ||
    candidateApplication.signalCode !== null;
  if (!processStopped) {
    throw new Error(
      `Candidate process ${candidateApplication.pid} did not stop before recovery`
    );
  }
  return { processStopped: true };
}

function quitUpdaterAfterEvidence() {
  setTimeout(() => app.quit(), 2000);
}

async function stopApplicationAfterJourneyCompletion(window, updaterStatus) {
  const completionPath = path.join(
    descriptor.fixtureStateDirectory,
    'journey-complete.json'
  );
  while (!fs.existsSync(completionPath)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopCandidateApplication();
  if (!window.isDestroyed()) {
    window.webContents.send(
      'updater-status',
      updaterStatus('Journey Complete', 'Closing test-owned product processes.')
    );
    window.hide();
  }
}

async function launchInstalledApplication(
  recovery = false,
  { transactionToken, onProcessStarted } = {}
) {
  const { resolveApplicationLauncher } = await updateEnginePromise;
  const launcher = resolveApplicationLauncher(
    descriptor.installationDirectory,
    descriptor.platform
  );
  if (
    path.resolve(launcher) !== path.resolve(descriptor.applicationLauncherPath)
  ) {
    throw new Error(
      'Production launcher resolution disagrees with Run Descriptor'
    );
  }
  appendHandoff({
    phase: 'production-launcher-resolved',
    launcher,
    recovery,
  });
  fs.rmSync(descriptor.startupHealthPath, { force: true });
  const entryPoint = path.join(
    descriptor.installationDirectory,
    'app/e2e-product-main.cjs'
  );
  if (!fs.existsSync(entryPoint)) {
    throw new Error('Installed application entry point is missing');
  }
  const applicationGuardEnvironment = descendantGuardEnvironment({
    logPath: path.join(
      descriptor.artifactDirectory,
      'packaged-application-traffic.jsonl'
    ),
    product: recovery
      ? 'last-known-good-application-descendant'
      : 'candidate-application-descendant',
    recordListeners: descriptor.deterministicTorrentInstallation,
    expectedEndpoints: [
      { host: '127.0.0.1', port: descriptor.clientSdkPort },
      { host: 'localhost', port: descriptor.clientSdkPort },
      {
        host: '127.0.0.1',
        port: Number(new URL(descriptor.fixtureBaseUrl).port),
      },
      ...(descriptor.deterministicTorrentInstallation
        ? [
            {
              host: '127.0.0.1',
              port: Number(new URL(descriptor.torrentTrackerUrl).port),
            },
            {
              host: '127.0.0.1',
              port: descriptor.torrentPeerPort,
            },
          ]
        : []),
    ],
  });
  const electronArgs = [
    `--remote-debugging-port=${descriptor.automationPort}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    entryPoint,
    `--ogi-update-transaction-token=${transactionToken}`,
  ];
  const launchEnvironment = {
    ...process.env,
    ...applicationGuardEnvironment,
    OGI_RUN_DESCRIPTOR: descriptorPath,
    OGI_RECOVERY_STARTUP_HEALTH: recovery ? 'true' : 'false',
    OGI_UPDATE_TRANSACTION_TOKEN: transactionToken,
  };
  // Linux proves AppImage-style exec ownership with an inherited proof fd.
  // Other hosts launch Electron directly because Linux procfs proof is unavailable.
  const processProofPath = path.join(
    descriptor.sandboxDirectory,
    `.ogi-process-proof-${transactionToken}`
  );
  let processProofDescriptor;
  if (process.platform === 'linux') {
    fs.rmSync(processProofPath, { force: true });
    processProofDescriptor = fs.openSync(processProofPath, 'wx+', 0o600);
    fs.writeFileSync(processProofDescriptor, transactionToken);
    fs.fsyncSync(processProofDescriptor);
  }
  try {
    candidateApplication =
      process.platform === 'linux'
        ? spawn(
            'python3',
            [
              '-c',
              'import os,sys; os.execv(sys.argv[1], sys.argv[1:])',
              process.execPath,
              ...electronArgs,
            ],
            {
              cwd: descriptor.installationDirectory,
              env: launchEnvironment,
              stdio: ['ignore', 'pipe', 'pipe', processProofDescriptor],
            }
          )
        : spawn(process.execPath, electronArgs, {
            cwd: descriptor.installationDirectory,
            env: launchEnvironment,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: process.platform === 'win32',
          });
  } finally {
    if (processProofDescriptor !== undefined) {
      fs.closeSync(processProofDescriptor);
      fs.rmSync(processProofPath, { force: true });
    }
  }
  candidateApplication.__ogiStartTime = Date.now();
  candidateApplication.stdout.pipe(
    fs.createWriteStream(mainLogPath, { flags: 'a' })
  );
  candidateApplication.stderr.pipe(
    fs.createWriteStream(mainLogPath, { flags: 'a' })
  );
  await new Promise((resolve, reject) => {
    candidateApplication.once('spawn', resolve);
    candidateApplication.once('error', reject);
  });
  if (process.platform === 'linux') {
    const identityDeadline = Date.now() + 5000;
    while (Date.now() < identityDeadline) {
      try {
        if (
          path.resolve(
            fs.readlinkSync(`/proc/${candidateApplication.pid}/exe`)
          ) === path.resolve(process.execPath)
        ) {
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const processIdentity = await readFixtureProcessIdentity(
    candidateApplication.pid
  );
  if (!processIdentity) {
    throw new Error('Fixture application process identity is unavailable');
  }
  if (!recovery && descriptor.recoveryFailure === 'pre-identity') {
    appendHandoff({
      phase: 'pre-identity-interruption-injected',
      pid: candidateApplication.pid,
      launcher,
      postExecExecutable: processIdentity.executable,
      proofBound: processIdentity.proofBound === true,
    });
    throw new Error(
      'Interrupted after AppImage-style exec and before onProcessStarted'
    );
  }
  onProcessStarted(processIdentity);
  appendHandoff({
    phase: recovery
      ? 'last-known-good-process-started'
      : 'application-launched',
    pid: candidateApplication.pid,
    launcher,
    recovery,
  });
  const health = await waitForStartupHealth(recovery, transactionToken);
  return {
    health: {
      ...health,
      version: 1,
      state: 'interactive',
      processAlive:
        candidateApplication.exitCode === null &&
        candidateApplication.signalCode === null,
      transactionToken,
    },
    processIdentity,
  };
}

async function recoverLastKnownGood(
  window,
  updaterRecovery,
  updaterStatus,
  error
) {
  const detail = error instanceof Error ? error.message : String(error);
  window.webContents.send(
    'updater-status',
    updaterRecovery(
      'Restoring Previous Installation',
      'The candidate update did not prove healthy. Your last known-good installation is being restored.'
    )
  );
  appendHandoff({ phase: 'recovery-started', error: detail });
  await stopCandidateApplication();
  if (fs.existsSync(descriptor.backupDirectory)) {
    fs.rmSync(descriptor.installationDirectory, {
      recursive: true,
      force: true,
    });
    fs.renameSync(descriptor.backupDirectory, descriptor.installationDirectory);
  }
  fs.rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
  fs.rmSync(descriptor.startupHealthPath, { force: true });
  const restoredVersion = fs.readFileSync(
    path.join(descriptor.installationDirectory, 'version.txt'),
    'utf8'
  );
  appendHandoff({
    phase: 'last-known-good-restored',
    version: restoredVersion,
  });

  const recoveryHealth = await launchInstalledApplication(true, {
    transactionToken: `pretransaction-${descriptor.runId}`,
    onProcessStarted: () => {},
  });
  if (!recoveryHealth.health.processAlive) {
    throw new Error('Last Known-Good exited before Startup Health');
  }
  appendHandoff({
    phase: 'last-known-good-launched',
    pid: candidateApplication.pid,
    version: restoredVersion,
    health: recoveryHealth.health,
  });
  await stopCandidateApplication();
  window.webContents.send(
    'updater-status',
    updaterStatus(
      'Previous Installation Restored',
      'The working installation was restored and launched successfully.'
    )
  );
  quitUpdaterAfterEvidence();
}

async function launchOfflineLastKnownGood() {
  const version = fs.readFileSync(
    path.join(descriptor.installationDirectory, 'version.txt'),
    'utf8'
  );
  const entryPoint = path.join(
    descriptor.installationDirectory,
    'app/e2e-product-main.cjs'
  );
  if (version !== 'v4.1.0-e2e' || !fs.existsSync(entryPoint)) {
    throw new Error('Offline Last Known-Good Installation is unavailable');
  }
  const electronArgs = [
    `--remote-debugging-port=${descriptor.automationPort}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    entryPoint,
    '--online=false',
  ];
  const applicationGuardEnvironment = descendantGuardEnvironment({
    logPath: path.join(
      descriptor.artifactDirectory,
      'packaged-application-traffic.jsonl'
    ),
    product: 'application-descendant',
    expectedEndpoints: [{ host: '127.0.0.1', port: descriptor.clientSdkPort }],
  });
  candidateApplication = spawn(process.execPath, electronArgs, {
    cwd: descriptor.installationDirectory,
    env: {
      ...process.env,
      ...applicationGuardEnvironment,
      OGI_RUN_DESCRIPTOR: descriptorPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  candidateApplication.stdout.pipe(
    fs.createWriteStream(mainLogPath, { flags: 'a' })
  );
  candidateApplication.stderr.pipe(
    fs.createWriteStream(mainLogPath, { flags: 'a' })
  );
  await new Promise((resolve, reject) => {
    candidateApplication.once('spawn', resolve);
    candidateApplication.once('error', reject);
  });
  appendHandoff({
    phase: 'offline-last-known-good-launched',
    pid: candidateApplication.pid,
    version,
    descriptorPath,
    online: false,
  });
}

async function fetchBuffer(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Fixture request failed: ${response.status} ${url}`);
  }
  return {
    response,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

function validateArtifactEnvelope(contents, releaseTag) {
  const artifact = JSON.parse(contents.toString('utf8'));
  if (
    artifact?.formatVersion !== 1 ||
    artifact.version !== releaseTag ||
    artifact.platform !== descriptor.platform ||
    artifact.executable !==
      (descriptor.platform === 'win32'
        ? 'OpenGameInstaller.exe'
        : 'OpenGameInstaller.AppImage') ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('Downloaded application content signature is invalid');
  }
  return artifact;
}

async function downloadAndLaunch(window, updaterStatus) {
  const {
    applyBlockmapPatch,
    assertIncrementalVersions,
    stageVerifiedDownload,
  } = await updateEnginePromise;
  const {
    installPreparedProductionUpdate,
    PRODUCTION_UPDATE_COORDINATOR_MARKER,
  } = await productionCoordinatorPromise;
  appendHandoff({
    phase: 'production-update-coordinator-executed',
    module: 'support/production-update-coordinator.mjs',
    marker: PRODUCTION_UPDATE_COORDINATOR_MARKER,
  });
  appendHandoff({ phase: 'release-requested', url: descriptor.releaseApiUrl });
  const releasesResponse = await fetch(descriptor.releaseApiUrl);
  if (!releasesResponse.ok) {
    throw new Error(
      `Fixture release request failed: ${releasesResponse.status}`
    );
  }
  const releases = await releasesResponse.json();
  const release = Array.isArray(releases) ? releases[0] : undefined;
  const asset = release?.assets?.find(
    (candidate) => candidate.name === 'OpenGameInstaller-e2e.json'
  );
  if (
    release?.tag_name !== 'v4.1.0-e2e' ||
    asset?.browser_download_url !== descriptor.artifactUrl ||
    !Number.isSafeInteger(asset?.size) ||
    typeof asset?.digest !== 'string'
  ) {
    throw new Error('Fixture release metadata is invalid');
  }

  let artifactBytes;
  if (descriptor.incrementalUpdate !== 'none') {
    const localVersion = fs
      .readFileSync(
        path.join(descriptor.installationDirectory, 'version.txt'),
        'utf8'
      )
      .trim();
    const currentBlockmapAsset = release.assets.find(
      (candidate) => candidate.name === `${asset.name}.blockmap`
    );
    const oldRelease = releases.find(
      (candidate) => candidate.tag_name === localVersion
    );
    const oldAsset = oldRelease?.assets?.find(
      (candidate) => candidate.name === asset.name
    );
    const oldBlockmapAsset = oldRelease?.assets?.find(
      (candidate) => candidate.name === `${asset.name}.blockmap`
    );
    assertIncrementalVersions(
      { fromVersion: oldRelease?.tag_name, toVersion: release.tag_name },
      localVersion,
      release.tag_name
    );
    if (
      !oldAsset?.digest ||
      !Number.isSafeInteger(oldAsset.size) ||
      !currentBlockmapAsset?.browser_download_url ||
      !oldBlockmapAsset?.browser_download_url
    ) {
      throw new Error('Compatible incremental release metadata is unavailable');
    }
    window.webContents.send(
      'updater-status',
      updaterStatus(
        'Applying Incremental Update',
        'Building the current Verified Release from the installed artifact.'
      )
    );
    appendHandoff({
      phase: 'incremental-selected',
      fromVersion: localVersion,
      toVersion: release.tag_name,
      blockmapUrl: currentBlockmapAsset.browser_download_url,
    });
    try {
      const mapsDirectory = path.join(
        descriptor.artifactDirectory,
        'blockmaps'
      );
      fs.mkdirSync(mapsDirectory, { recursive: true });
      const oldMapPath = path.join(mapsDirectory, 'old.blockmap');
      const currentMapPath = path.join(mapsDirectory, 'current.blockmap');
      const [oldMap, currentMap] = await Promise.all([
        fetchBuffer(oldBlockmapAsset.browser_download_url),
        fetchBuffer(currentBlockmapAsset.browser_download_url),
      ]);
      fs.writeFileSync(oldMapPath, oldMap.buffer);
      fs.writeFileSync(currentMapPath, currentMap.buffer);
      const sourceArtifact = path.join(
        descriptor.installationDirectory,
        'source-artifact.json'
      );
      const patchedArtifact = path.join(
        descriptor.artifactDirectory,
        'patched-current.json'
      );
      await applyBlockmapPatch({
        sourceArtifact,
        oldBlockmapPath: oldMapPath,
        outputArtifact: patchedArtifact,
        newBlockmapPath: currentMapPath,
        expectedArtifact: { size: asset.size, digest: asset.digest },
        downloadRange: async (start, end) => {
          const { response, buffer } = await fetchBuffer(
            asset.browser_download_url,
            { headers: { Range: `bytes=${start}-${end}` } }
          );
          if (
            response.status !== 206 ||
            response.headers.get('content-range') !==
              `bytes ${start}-${end}/${asset.size}`
          ) {
            throw new Error('Invalid incremental range response');
          }
          return buffer;
        },
      });
      artifactBytes = fs.readFileSync(patchedArtifact);
      validateArtifactEnvelope(artifactBytes, release.tag_name);
      appendHandoff({
        phase: 'incremental-applied',
        fromVersion: localVersion,
        toVersion: release.tag_name,
        patchedBytes: artifactBytes.byteLength,
        productionEngine: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendHandoff({ phase: 'incremental-rejected', error: detail });
      window.webContents.send(
        'updater-status',
        updaterStatus(
          'Falling Back to Full Download',
          'The incremental patch was rejected before replacement. Downloading the full Verified Release.',
          undefined,
          detail
        )
      );
      appendHandoff({
        phase: 'full-download-fallback-started',
        reason: detail,
        lastKnownGoodVersion: localVersion,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  if (!artifactBytes) {
    appendHandoff({ phase: 'artifact-requested', url: descriptor.artifactUrl });
    if (descriptor.recoveryFailure === 'download') {
      throw new Error('Candidate download was interrupted before completion');
    }
    const downloadDirectory = path.join(
      descriptor.artifactDirectory,
      'verified-downloads'
    );
    const verifiedPath = await stageVerifiedDownload({
      workingPath: descriptor.installationDirectory,
      stagingDirectory: downloadDirectory,
      expected: { size: asset.size, digest: asset.digest },
      download: async (destination) => {
        const { buffer } = await fetchBuffer(asset.browser_download_url);
        fs.writeFileSync(destination, buffer);
      },
      validateContent: (candidatePath) => {
        validateArtifactEnvelope(
          fs.readFileSync(candidatePath),
          release.tag_name
        );
      },
    });
    artifactBytes = fs.readFileSync(verifiedPath);
    fs.rmSync(verifiedPath, { force: true });
    if (descriptor.incrementalUpdate !== 'none') {
      appendHandoff({
        phase: 'full-download-fallback-completed',
        version: release.tag_name,
        size: asset.size,
        digest: asset.digest,
        productionEngine: true,
      });
    }
  }

  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  if (descriptor.recoveryFailure === 'incomplete-content') {
    artifact.files = 'truncated';
  } else if (descriptor.recoveryFailure === 'unsafe-archive-path') {
    artifact.files = [
      {
        path: '../escaped.txt',
        mode: 0o644,
        contents: Buffer.from('unsafe').toString('base64'),
      },
    ];
  } else if (descriptor.recoveryFailure === 'missing-required-file') {
    artifact.files = [];
  }
  materializeArtifact(artifact);
  appendHandoff({
    phase: 'last-known-good-retained',
    version: fs.readFileSync(
      path.join(descriptor.installationDirectory, 'version.txt'),
      'utf8'
    ),
  });

  const paths = {
    stateRoot: descriptor.sandboxDirectory,
    workingPath: descriptor.installationDirectory,
    backupPath: descriptor.backupDirectory,
    retiredBackupPath: `${descriptor.backupDirectory}-retired`,
    journalPath: path.join(descriptor.sandboxDirectory, 'transaction.json'),
    metadataPath: path.join(
      descriptor.sandboxDirectory,
      'installed-version.txt'
    ),
  };
  fs.writeFileSync(
    paths.metadataPath,
    fs.readFileSync(
      path.join(descriptor.installationDirectory, 'version.txt'),
      'utf8'
    )
  );
  let transactionHealth;
  try {
    transactionHealth = await installPreparedProductionUpdate({
      prepared: {
        candidatePath: descriptor.stagingDirectory,
        assetName: asset.name,
        tagName: release.tag_name,
      },
      paths,
      previousVersion: fs.readFileSync(
        path.join(descriptor.installationDirectory, 'version.txt'),
        'utf8'
      ),
      terminateOwnedProcess: terminateFixtureOwnedProcess,
      processIsAlive: fixtureProcessIsAlive,
      discoverOwnedProcesses: discoverFixtureProcesses,
      resolveLaunchExecutable: resolveFixtureLaunchExecutable,
      launchAndWaitForHealth: async (launchInput) => {
        const { recovery } = launchInput;
        if (!recovery && descriptor.recoveryFailure === 'replacement') {
          const workingLauncher = path.join(
            descriptor.installationDirectory,
            descriptor.platform === 'win32'
              ? 'OpenGameInstaller.exe'
              : 'OpenGameInstaller.AppImage'
          );
          const candidateEntryPoint = path.join(
            descriptor.installationDirectory,
            'app/e2e-product-main.cjs'
          );
          fs.rmSync(workingLauncher, { force: true });
          fs.rmSync(candidateEntryPoint, { force: true });
          appendHandoff({
            phase: 'replacement-failure-injected',
            workingVersion: fs.readFileSync(
              path.join(descriptor.installationDirectory, 'version.txt'),
              'utf8'
            ),
            workingLauncherPresent: fs.existsSync(workingLauncher),
            candidateEntryPointPresent: fs.existsSync(candidateEntryPoint),
          });
          throw new Error('Candidate replacement failed after atomic swap');
        }
        const result = await launchInstalledApplication(recovery, launchInput);
        if (recovery) {
          appendHandoff({
            phase: 'last-known-good-restored',
            version: fs.readFileSync(
              path.join(descriptor.installationDirectory, 'version.txt'),
              'utf8'
            ),
          });
          appendHandoff({
            phase: 'last-known-good-launched',
            pid: candidateApplication.pid,
            health: result.health,
          });
        }
        return result;
      },
      onDiagnostic: (message) =>
        appendHandoff({ phase: 'production-coordinator-diagnostic', message }),
    });
  } catch (error) {
    if (error?.recoveryCompleted) {
      await stopCandidateApplication();
      window.webContents.send(
        'updater-status',
        updaterStatus(
          'Previous Installation Restored',
          'The working installation was restored and proved healthy.'
        )
      );
    }
    throw error;
  }
  appendHandoff({
    phase: 'last-known-good-released',
    health: transactionHealth,
    backupPresent: fs.existsSync(descriptor.backupDirectory),
  });
  return transactionHealth;
}

ipcMain.handle('get-branches', () => ({ ok: true, branches: ['main'] }));
ipcMain.handle('get-recent-commits', () => ({ ok: true, commits: [] }));

app
  .whenReady()
  .then(async () => {
    const { decideUpdaterStartup } = await import(
      './support/updater-offline-decision.js'
    );
    const startupDecision = decideUpdaterStartup(process.argv, true);
    if (
      descriptor.offlineProductBehavior &&
      startupDecision.action !== 'skip-update-and-launch-offline'
    ) {
      throw new Error(
        'Production updater startup logic did not select offline'
      );
    }
    if (
      descriptor.offlineProductBehavior ||
      descriptor.incrementalUpdate !== 'none'
    ) {
      installOfflineTrafficGuard({
        session: session.defaultSession,
        logPath: path.join(
          descriptor.artifactDirectory,
          'packaged-updater-traffic.jsonl'
        ),
        product: 'updater',
        expectedEndpoints:
          descriptor.incrementalUpdate === 'none'
            ? []
            : [
                {
                  host: '127.0.0.1',
                  port: Number(new URL(descriptor.fixtureBaseUrl).port),
                },
              ],
      });
    }
    const { updaterFailure, updaterRecovery, updaterStatus } = await import(
      './dist/status.js'
    );
    const window = new BrowserWindow({
      width: 800,
      height: 700,
      show: true,
      webPreferences: {
        preload: path.join(updaterDirectory, 'dist/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.webContents.on('console-message', (details) => {
      fs.appendFileSync(
        rendererLogPath,
        `[updater-renderer:${details.level}] ${details.message}\n`
      );
    });
    ipcMain.on('choose-channel', (_event, choice) => {
      void (async () => {
        if (choice?.channel !== 'stable') {
          throw new Error('The Product Journey requires Stable');
        }
        if (startupDecision.action === 'skip-update-and-launch-offline') {
          appendHandoff({
            phase: 'production-updater-offline-decision',
            action: startupDecision.action,
            onlineState: startupDecision.onlineState,
          });
          window.webContents.send(
            'updater-status',
            updaterStatus(
              'Offline Mode',
              'Skipping update checks and launching the Last Known-Good Installation.'
            )
          );
          await launchOfflineLastKnownGood();
          window.webContents.send(
            'updater-status',
            updaterStatus(
              'Offline Last Known-Good Launched',
              'The working installation launched without update traffic.'
            )
          );
          return;
        }
        window.webContents.send(
          'updater-status',
          updaterStatus('Installing Packaged Fixture Release')
        );
        const health = await downloadAndLaunch(window, updaterStatus);
        window.webContents.send(
          'updater-status',
          updaterStatus(
            'Startup Health Confirmed',
            `${health.surface} UI is interactive`
          )
        );
        void stopApplicationAfterJourneyCompletion(window, updaterStatus).catch(
          (error) => {
            logMain('Journey completion cleanup failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            app.exit(1);
          }
        );
      })().catch(async (error) => {
        logMain('Packaged handoff failed', { error: error.message });
        if (error?.recoveryCompleted) {
          quitUpdaterAfterEvidence();
          return;
        }
        if (error?.processStopped === false) {
          const detail = error instanceof Error ? error.message : String(error);
          window.webContents.send(
            'updater-status',
            updaterFailure(
              'Recovery Suppressed',
              `Candidate process-tree termination was not verified: ${detail}`
            )
          );
          quitUpdaterAfterEvidence();
          return;
        }
        try {
          await recoverLastKnownGood(
            window,
            updaterRecovery,
            updaterStatus,
            error
          );
        } catch (recoveryError) {
          const detail =
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
          logMain('Last Known-Good recovery failed', { error: detail });
          window.webContents.send(
            'updater-status',
            updaterFailure('Recovery Failed', detail)
          );
        }
      });
    });
    await window.loadFile(path.join(updaterDirectory, 'public/index.html'));
    window.webContents.send('show-channel-picker');
    logMain('Packaged updater renderer ready', { runId: descriptor.runId });
  })
  .catch((error) => {
    logMain('Packaged updater failed to start', { error: error.message });
    app.exit(1);
  });

app.on('window-all-closed', () => {
  app.quit();
});
