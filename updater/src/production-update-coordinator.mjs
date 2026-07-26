import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  confirmAppliedTransactionRename,
  createInstallationManifest,
  restoreInterruptedTransaction,
  transactionalReplaceAndRequireHealth,
  verifyInstallationManifest,
} from './update-engine.mjs';
import { parseWindowsJobResultEvidence } from './windows-job-evidence.mjs';

export const PRODUCTION_UPDATE_COORDINATOR_MARKER =
  'ogi-production-update-coordinator-v2';
const JOURNAL_VERSION = 2;
const PHASES = new Set([
  'prepared',
  'candidate-active',
  'restored',
  'recovery-active',
  'recovery-launched',
  'recovery-healthy',
  'committed',
]);

function contained(root, target) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const fromRoot = relative(normalizedRoot, normalizedTarget);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

function validIdentity(value) {
  return (
    Number.isSafeInteger(value?.pid) &&
    value.pid > 0 &&
    typeof value.startTime === 'string' &&
    value.startTime.length > 0 &&
    typeof value.executable === 'string' &&
    isAbsolute(value.executable) &&
    typeof value.transactionToken === 'string' &&
    value.transactionToken.length >= 16 &&
    (value.processRole === undefined ||
      ['application', 'windows-job-wrapper'].includes(value.processRole)) &&
    (value.windowsJobWrapperToken === undefined ||
      (typeof value.windowsJobWrapperToken === 'string' &&
        value.windowsJobWrapperToken.length >= 16)) &&
    (value.applicationPid === undefined ||
      (Number.isSafeInteger(value.applicationPid) &&
        value.applicationPid > 0)) &&
    ((value.windowsJobStopPath === undefined &&
      value.windowsJobResultPath === undefined) ||
      (typeof value.windowsJobStopPath === 'string' &&
        isAbsolute(value.windowsJobStopPath) &&
        typeof value.windowsJobResultPath === 'string' &&
        isAbsolute(value.windowsJobResultPath)))
  );
}

function validateJournal(value, { stateRoot, expectedPaths }) {
  if (!value || value.version !== JOURNAL_VERSION) {
    throw new Error('Transaction journal version is invalid');
  }
  if (
    typeof value.transactionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.transactionId) ||
    typeof value.transactionToken !== 'string' ||
    value.transactionToken.length < 16 ||
    !PHASES.has(value.phase) ||
    typeof value.previousVersion !== 'string' ||
    typeof value.targetVersion !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Transaction journal schema is invalid');
  }
  for (const key of [
    'workingPath',
    'candidatePath',
    'backupPath',
    'retiredBackupPath',
  ]) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) {
      throw new Error(`Transaction journal ${key} is invalid`);
    }
    if (
      expectedPaths?.[key] &&
      resolve(value[key]) !== resolve(expectedPaths[key])
    ) {
      throw new Error(
        `Transaction journal ${key} does not match production state`
      );
    }
  }
  if (
    !contained(stateRoot, value.candidatePath) ||
    !contained(stateRoot, value.backupPath) ||
    !contained(stateRoot, value.retiredBackupPath)
  ) {
    throw new Error('Transaction journal path escapes the owned state root');
  }
  if (
    value.activeProcess !== undefined &&
    !validIdentity(value.activeProcess)
  ) {
    throw new Error('Transaction journal process identity is invalid');
  }
  for (const key of ['backupManifest', 'candidateManifest']) {
    if (
      value[key]?.version !== 1 ||
      typeof value[key].digest !== 'string' ||
      !Array.isArray(value[key].entries)
    ) {
      throw new Error(`Transaction journal ${key} is invalid`);
    }
  }
  if (
    value.launchIntent !== undefined &&
    (typeof value.launchIntent.role !== 'string' ||
      !['candidate', 'recovery'].includes(value.launchIntent.role) ||
      typeof value.launchIntent.executable !== 'string' ||
      !isAbsolute(value.launchIntent.executable) ||
      value.launchIntent.transactionToken !== value.transactionToken ||
      typeof value.launchIntent.requestedAt !== 'string' ||
      (value.launchIntent.allowProofBoundExecTransition !== undefined &&
        (value.launchIntent.allowProofBoundExecTransition !== true ||
          typeof value.launchIntent.launcherDigest !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(value.launchIntent.launcherDigest))) ||
      (value.launchIntent.windowsJob !== undefined &&
        (typeof value.launchIntent.windowsJob.wrapperExecutable !== 'string' ||
          !isAbsolute(value.launchIntent.windowsJob.wrapperExecutable) ||
          typeof value.launchIntent.windowsJob.wrapperScript !== 'string' ||
          !isAbsolute(value.launchIntent.windowsJob.wrapperScript) ||
          typeof value.launchIntent.windowsJob.wrapperToken !== 'string' ||
          value.launchIntent.windowsJob.wrapperToken.length < 16 ||
          typeof value.launchIntent.windowsJob.launchPath !== 'string' ||
          !isAbsolute(value.launchIntent.windowsJob.launchPath) ||
          typeof value.launchIntent.windowsJob.resultPath !== 'string' ||
          !isAbsolute(value.launchIntent.windowsJob.resultPath) ||
          typeof value.launchIntent.windowsJob.stopPath !== 'string' ||
          !isAbsolute(value.launchIntent.windowsJob.stopPath) ||
          value.launchIntent.windowsJob.wrapperToken ===
            value.transactionToken ||
          new Set([
            value.launchIntent.windowsJob.launchPath,
            value.launchIntent.windowsJob.resultPath,
            value.launchIntent.windowsJob.stopPath,
          ]).size !== 3 ||
          !contained(stateRoot, value.launchIntent.windowsJob.launchPath) ||
          !contained(stateRoot, value.launchIntent.windowsJob.resultPath) ||
          !contained(stateRoot, value.launchIntent.windowsJob.stopPath))))
  ) {
    throw new Error('Transaction journal launch intent is invalid');
  }
  if (value.launchIntent?.allowProofBoundExecTransition === true) {
    const manifest =
      value.launchIntent.role === 'candidate'
        ? value.candidateManifest
        : value.backupManifest;
    if (
      !manifest.entries.some(
        (entry) =>
          entry.type === 'file' &&
          entry.sha256 === value.launchIntent.launcherDigest
      )
    ) {
      throw new Error(
        'Transaction journal executable transition is not launcher-manifest-bound'
      );
    }
  }
  if (
    value.targetMetadata !== undefined &&
    (value.targetMetadata.version !== value.targetVersion ||
      typeof value.targetMetadata.digest !== 'string')
  ) {
    throw new Error('Transaction journal target metadata is invalid');
  }
  if (
    value.verifiedHealth !== undefined &&
    (value.verifiedHealth.version !== 1 ||
      value.verifiedHealth.state !== 'interactive' ||
      value.verifiedHealth.processAlive !== true ||
      value.verifiedHealth.transactionToken !== value.transactionToken ||
      !Number.isSafeInteger(value.verifiedHealth.pid))
  ) {
    throw new Error('Transaction journal verified health is invalid');
  }
  return value;
}

function syncPosixDirectories(paths) {
  for (const directory of [
    ...new Set(paths.map((target) => resolve(target))),
  ]) {
    let descriptor;
    try {
      descriptor = openSync(directory, 'r');
      fsyncSync(descriptor);
    } catch (error) {
      throw new Error(
        `Directory fsync failed for ${directory}: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const WINDOWS_DURABILITY_HELPER = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OgiDurability {
  private const int MoveFileReplaceExisting = 0x1;
  private const int MoveFileWriteThrough = 0x8;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool MoveFileEx(string existing, string replacement, int flags);
  public static void Move(string from, string to, bool replace) {
    int flags = MoveFileWriteThrough | (replace ? MoveFileReplaceExisting : 0);
    if (!MoveFileEx(from, to, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Confirm(string path, string temporary) {
    if (System.IO.File.Exists(path) || System.IO.Directory.Exists(path)) {
      if (System.IO.File.Exists(temporary) || System.IO.Directory.Exists(temporary))
        throw new InvalidOperationException("write-through confirmation path already exists");
      Move(path, temporary, false);
    } else if (!(System.IO.File.Exists(temporary) || System.IO.Directory.Exists(temporary))) {
      throw new InvalidOperationException("write-through confirmation target is missing");
    }
    Move(temporary, path, false);
  }
}`;

export function createProductionDurabilityAdapter({
  platform = process.platform,
  runWindowsHelper = (script) =>
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        encoding: 'utf8',
      }
    ),
} = {}) {
  if (platform !== 'win32') {
    return {
      replace(from, to) {
        renameSync(from, to);
        syncPosixDirectories([dirname(from), dirname(to)]);
      },
      durableRename(from, to) {
        renameSync(from, to);
        syncPosixDirectories([dirname(from), dirname(to)]);
      },
      syncDirectories: syncPosixDirectories,
    };
  }
  const invoke = (operation) => {
    const script = `Add-Type -TypeDefinition @'\n${WINDOWS_DURABILITY_HELPER}\n'@; ${operation}`;
    const result = runWindowsHelper(script);
    if (result?.status !== 0) {
      throw new Error(
        `Windows write-through durability helper failed: ${result?.stderr || result?.error?.message || 'unknown error'}`
      );
    }
  };
  const syncDirectories = () => {
    // Windows namespace durability is supplied only by the documented
    // MOVEFILE_WRITE_THROUGH operation below. Directory handles are not
    // advertised as flushable because FlushFileBuffers does not support them.
  };
  const move = (from, to, replace) => {
    invoke(
      `[OgiDurability]::Move(${quotePowerShell(from)}, ${quotePowerShell(to)}, $${replace ? 'true' : 'false'})`
    );
  };
  const confirmationPath = (target) =>
    `${target}.ogi-write-through-confirmation`;
  const confirmAppliedRename = (target) => {
    invoke(
      `[OgiDurability]::Confirm(${quotePowerShell(target)}, ${quotePowerShell(confirmationPath(target))})`
    );
  };
  return {
    replace: (from, to) => move(from, to, true),
    durableRename: (from, to) => move(from, to, false),
    getRenameConfirmationPath: confirmationPath,
    confirmAppliedRename,
    syncDirectories,
  };
}

function transactionFilesystem(durability) {
  return {
    exists: existsSync,
    rename: renameSync,
    durableRename: durability.durableRename,
    remove: (target) => rmSync(target, { recursive: true, force: true }),
    device: (target) => statSync(target).dev,
    getRenameConfirmationPath: durability.getRenameConfirmationPath,
    confirmAppliedRename: durability.confirmAppliedRename,
    syncDirectories: durability.syncDirectories,
  };
}

function metadataRecord(version) {
  return {
    version,
    digest: createHash('sha256').update(version).digest('hex'),
  };
}

export function writeDurableVersionMetadata({
  path,
  version,
  fault = () => {},
  durability = createProductionDurabilityAdapter(),
}) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Durable version metadata is invalid');
  }
  atomicWrite(path, version, fault, durability);
  return metadataRecord(version);
}

export function verifyDurableVersionMetadata({
  path,
  expected,
  repair = false,
  durability = createProductionDurabilityAdapter(),
}) {
  if (
    typeof expected?.version !== 'string' ||
    expected.digest !== metadataRecord(expected.version).digest
  ) {
    throw new Error('Expected version metadata record is invalid');
  }
  let actual;
  try {
    actual = readFileSync(path, 'utf8');
  } catch (error) {
    if (!repair) throw error;
  }
  if (actual !== expected.version) {
    if (!repair)
      throw new Error('Version metadata does not match committed target');
    writeDurableVersionMetadata({
      path,
      version: expected.version,
      durability,
    });
  }
  return expected;
}

function atomicWrite(
  path,
  contents,
  fault = () => {},
  durability = createProductionDurabilityAdapter()
) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, contents);
    fault('after-temp-write');
    fsyncSync(descriptor);
    fault('after-file-fsync');
    closeSync(descriptor);
    descriptor = undefined;
    durability.replace(temporaryPath, path);
    fault('after-rename');
    fault('after-dir-fsync');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

export function writeTransactionJournal({
  journalPath,
  stateRoot,
  journal,
  fault = () => {},
  durability = createProductionDurabilityAdapter(),
}) {
  const validated = validateJournal(journal, {
    stateRoot,
    expectedPaths: journal,
  });
  const previousPath = `${journalPath}.last-known-good`;
  if (existsSync(journalPath)) {
    const previousTemporary = `${previousPath}.tmp-${randomUUID()}`;
    copyFileSync(journalPath, previousTemporary);
    const descriptor = openSync(previousTemporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    durability.replace(previousTemporary, previousPath);
  }
  atomicWrite(journalPath, JSON.stringify(validated), fault, durability);
  return validated;
}

function parseJournal(path, validation) {
  if (!existsSync(path)) return { journal: null, error: null };
  try {
    return {
      journal: validateJournal(
        JSON.parse(readFileSync(path, 'utf8')),
        validation
      ),
      error: null,
    };
  } catch (error) {
    return { journal: null, error };
  }
}

export function readValidatedTransactionJournal({
  journalPath,
  stateRoot,
  expectedPaths,
}) {
  const validation = { stateRoot, expectedPaths };
  const current = parseJournal(journalPath, validation);
  if (current.journal) {
    return { journal: current.journal, source: 'current', diagnostics: [] };
  }
  const previous = parseJournal(`${journalPath}.last-known-good`, validation);
  if (previous.journal) {
    return {
      journal: previous.journal,
      source: 'last-known-good',
      diagnostics: current.error
        ? [`Current transaction journal is invalid: ${current.error.message}`]
        : [],
    };
  }
  return {
    journal: null,
    source: 'none',
    diagnostics: [current.error, previous.error]
      .filter(Boolean)
      .map((error) => `Transaction journal is invalid: ${error.message}`),
  };
}

function ownershipPath(paths) {
  return `${paths.journalPath}.backup-ownership`;
}

function writeBackupOwnership(paths, journal, fault, durability) {
  atomicWrite(
    ownershipPath(paths),
    JSON.stringify({
      version: JOURNAL_VERSION,
      transactionId: journal.transactionId,
      transactionToken: journal.transactionToken,
      workingPath: journal.workingPath,
      backupPath: journal.backupPath,
      retiredBackupPath: journal.retiredBackupPath,
      phase: journal.phase,
      candidatePath: journal.candidatePath,
      createdAt: journal.createdAt,
      previousVersion: journal.previousVersion,
      targetVersion: journal.targetVersion,
      backupManifest: journal.backupManifest,
      candidateManifest: journal.candidateManifest,
      ...(journal.targetMetadata === undefined
        ? {}
        : { targetMetadata: journal.targetMetadata }),
      ...(journal.launchIntent === undefined
        ? {}
        : { launchIntent: journal.launchIntent }),
      ...(journal.verifiedHealth === undefined
        ? {}
        : { verifiedHealth: journal.verifiedHealth }),
      ...(journal.activeProcess === undefined
        ? {}
        : { activeProcess: journal.activeProcess }),
    }),
    fault,
    durability
  );
}

function readBackupOwnership(paths) {
  const path = ownershipPath(paths);
  if (!existsSync(path)) return null;
  try {
    return validateJournal(JSON.parse(readFileSync(path, 'utf8')), {
      stateRoot: paths.stateRoot,
      expectedPaths: paths,
    });
  } catch {
    return null;
  }
}

function clearTransactionRecords(
  paths,
  durability = createProductionDurabilityAdapter()
) {
  for (const path of [
    paths.journalPath,
    `${paths.journalPath}.last-known-good`,
    ownershipPath(paths),
  ]) {
    rmSync(path, { force: true });
  }
  durability.syncDirectories([dirname(paths.journalPath)]);
}

function buildLaunchIntent({
  role,
  resolvedLaunch,
  transactionToken,
  installationManifest,
}) {
  const launch =
    typeof resolvedLaunch === 'string'
      ? { executable: resolvedLaunch }
      : resolvedLaunch;
  if (
    typeof launch?.executable !== 'string' ||
    !isAbsolute(launch.executable)
  ) {
    throw new Error('Resolved launch executable is invalid');
  }
  if (launch.allowProofBoundExecTransition === true) {
    const digestProven = installationManifest.entries.some(
      (entry) => entry.type === 'file' && entry.sha256 === launch.launcherDigest
    );
    if (!digestProven) {
      throw new Error(
        'Proof-bound executable transition lacks exact launcher manifest proof'
      );
    }
  }
  return {
    role,
    executable: launch.executable,
    transactionToken,
    requestedAt: new Date().toISOString(),
    ...(launch.allowProofBoundExecTransition === true
      ? {
          allowProofBoundExecTransition: true,
          launcherDigest: launch.launcherDigest,
        }
      : {}),
    ...(launch.windowsJob ? { windowsJob: { ...launch.windowsJob } } : {}),
  };
}

function identitiesMatch(expected, actual) {
  return (
    expected.pid === actual.pid &&
    expected.startTime === actual.startTime &&
    resolve(expected.executable) === resolve(actual.executable) &&
    expected.transactionToken === actual.transactionToken
  );
}

export async function stopOwnedProcess({
  expectedIdentity,
  terminateOwnedProcess,
}) {
  if (!expectedIdentity) {
    return { processStopped: true, processTreeStopped: true };
  }
  if (!validIdentity(expectedIdentity)) {
    throw new Error('Owned process identity is invalid');
  }
  if (typeof terminateOwnedProcess !== 'function') {
    throw new Error(
      'OS identity-handle termination is unavailable; refusing to signal by reusable PID'
    );
  }
  const result = await terminateOwnedProcess(expectedIdentity);
  if (result?.processStopped === true && result?.processTreeStopped === true) {
    return { processStopped: true, processTreeStopped: true };
  }
  throw new Error(
    `OS identity handle could not safely stop the complete owned process tree for ${expectedIdentity.pid}`
  );
}

async function reconcileLaunchIntent({
  journal,
  discoverOwnedProcesses,
  terminateOwnedProcess,
}) {
  if (!journal.launchIntent) return { processStopped: true };
  const discovered = await discoverOwnedProcesses(journal.launchIntent);
  const windowsJob = journal.launchIntent.windowsJob;
  for (const identity of discovered) {
    const executable = resolve(identity.executable);
    const matchesWindowsRole =
      windowsJob &&
      ((identity.processRole === 'windows-job-wrapper' &&
        executable === resolve(windowsJob.wrapperExecutable) &&
        identity.windowsJobWrapperToken === windowsJob.wrapperToken) ||
        (identity.processRole === 'application' &&
          executable === resolve(journal.launchIntent.executable)));
    const matchesDirectLaunch =
      !windowsJob &&
      (executable === resolve(journal.launchIntent.executable) ||
        (journal.launchIntent.allowProofBoundExecTransition === true &&
          identity.proofBound === true));
    if (
      !validIdentity(identity) ||
      identity.transactionToken !== journal.transactionToken ||
      (!matchesWindowsRole && !matchesDirectLaunch)
    ) {
      throw new Error(
        'Discovered launch process does not match durable transaction ownership'
      );
    }
  }
  if (windowsJob) {
    const wrapper = discovered.find(
      (identity) => identity.processRole === 'windows-job-wrapper'
    );
    const application = discovered.find(
      (identity) => identity.processRole === 'application'
    );
    const jobMember = wrapper ?? application;
    if (jobMember) {
      await stopOwnedProcess({
        expectedIdentity: jobMember,
        terminateOwnedProcess,
      });
      return { processStopped: true };
    }
    if (existsSync(windowsJob.resultPath)) {
      const result = parseWindowsJobResultEvidence(
        readFileSync(windowsJob.resultPath, 'utf8')
      );
      if (
        result.version !== 3 ||
        result.verifiedAfterClose !== true ||
        result.survivingPids.length !== 0 ||
        result.errors.length !== 0 ||
        result.terminatedPids.length !== result.activePidsBeforeClose.length
      ) {
        throw new Error(
          'Windows Job Object process tree stop was not verified'
        );
      }
      return { processStopped: true };
    }
    if (existsSync(windowsJob.launchPath)) {
      throw new Error(
        'Windows Job Object launch began without verified post-close evidence'
      );
    }
    return { processStopped: true };
  }
  for (const identity of discovered) {
    await stopOwnedProcess({
      expectedIdentity: identity,
      terminateOwnedProcess,
    });
  }
  return { processStopped: true };
}

function validBoundLaunch(result, transactionToken) {
  const identity = result?.processIdentity;
  const health = result?.health ?? result;
  if (
    !validIdentity(identity) ||
    identity.transactionToken !== transactionToken ||
    health?.version !== 1 ||
    health.state !== 'interactive' ||
    health.processAlive !== true ||
    health.pid !== (identity.applicationPid ?? identity.pid) ||
    health.transactionToken !== transactionToken
  ) {
    throw new Error(
      'Startup Health is not bound to the owned transaction process'
    );
  }
  return { health, identity };
}

function expectedJournalPaths(paths, candidatePath) {
  return {
    workingPath: paths.workingPath,
    candidatePath,
    backupPath: paths.backupPath,
    retiredBackupPath: paths.retiredBackupPath,
  };
}

export async function installPreparedProductionUpdate({
  prepared,
  paths,
  previousVersion,
  launchAndWaitForHealth,
  terminateOwnedProcess,
  resolveLaunchExecutable = ({ workingPath }) => workingPath,
  discoverOwnedProcesses = async () => [],
  commitMetadata = async () => {},
  restoreMetadata = async () => {},
  cleanupAfterCommit = async () => {},
  onDiagnostic = () => {},
  journalFault = () => {},
  transactionId = randomUUID(),
  transactionToken = randomUUID(),
  durability = createProductionDurabilityAdapter(),
  fileSystem,
  retry,
}) {
  mkdirSync(paths.stateRoot, { recursive: true });
  const effectiveFileSystem = fileSystem ?? transactionFilesystem(durability);
  const backupManifest = createInstallationManifest(paths.workingPath);
  const candidateManifest = createInstallationManifest(prepared.candidatePath);
  let journal = {
    version: JOURNAL_VERSION,
    transactionId,
    transactionToken,
    phase: 'prepared',
    previousVersion,
    targetVersion: prepared.tagName,
    workingPath: paths.workingPath,
    candidatePath: prepared.candidatePath,
    backupPath: paths.backupPath,
    retiredBackupPath: paths.retiredBackupPath,
    createdAt: new Date().toISOString(),
    backupManifest,
    candidateManifest,
  };
  const persist = (next) => {
    journal = { ...journal, ...next };
    writeTransactionJournal({
      journalPath: paths.journalPath,
      stateRoot: paths.stateRoot,
      journal,
      fault: journalFault,
      durability,
    });
    writeBackupOwnership(paths, journal, journalFault, durability);
  };
  persist({});

  const launchBound = async ({ recovery, workingPath }) => {
    const launchIntent = buildLaunchIntent({
      role: recovery ? 'recovery' : 'candidate',
      resolvedLaunch: await resolveLaunchExecutable({
        recovery,
        workingPath,
        transactionToken,
      }),
      transactionToken,
      installationManifest: recovery ? backupManifest : candidateManifest,
    });
    persist({ launchIntent });
    const result = await launchAndWaitForHealth({
      recovery,
      workingPath,
      transactionToken,
      launchIntent,
      onProcessStarted: (identity) => {
        if (
          !validIdentity(identity) ||
          identity.transactionToken !== transactionToken
        ) {
          throw new Error('Launched process identity is not transaction-bound');
        }
        persist({
          phase: recovery ? 'recovery-launched' : 'candidate-active',
          activeProcess: identity,
        });
      },
    });
    const bound = validBoundLaunch(result, transactionToken);
    if (
      !journal.activeProcess ||
      !identitiesMatch(journal.activeProcess, bound.identity)
    ) {
      throw new Error(
        'Startup Health process disagrees with the journaled process identity'
      );
    }
    persist({
      ...(recovery ? { phase: 'recovery-healthy' } : {}),
      verifiedHealth: bound.health,
    });
    return bound.health;
  };

  const stopJournaledProcess = async () => {
    await stopOwnedProcess({
      expectedIdentity: journal.activeProcess,
      terminateOwnedProcess,
    });
    return reconcileLaunchIntent({
      journal,
      discoverOwnedProcesses,
      terminateOwnedProcess,
    });
  };

  try {
    const health = await transactionalReplaceAndRequireHealth({
      workingPath: paths.workingPath,
      candidatePath: prepared.candidatePath,
      backupPath: paths.backupPath,
      retiredBackupPath: paths.retiredBackupPath,
      expectedBackupManifest: backupManifest,
      expectedCandidateManifest: candidateManifest,
      launchAndWaitForHealth: launchBound,
      beforeRecovery: stopJournaledProcess,
      markRestored: async () => persist({ phase: 'restored' }),
      afterRestore: async () => {
        if (paths.metadataPath) {
          writeDurableVersionMetadata({
            path: paths.metadataPath,
            version: previousVersion,
            durability,
          });
        }
        await restoreMetadata({ previousVersion, prepared });
      },
      commitCandidate: async (candidateHealth) => {
        const targetMetadata = paths.metadataPath
          ? writeDurableVersionMetadata({
              path: paths.metadataPath,
              version: prepared.tagName,
              fault: journalFault,
              durability,
            })
          : metadataRecord(prepared.tagName);
        await commitMetadata({
          prepared,
          health: candidateHealth,
          previousVersion,
          targetMetadata,
        });
        persist({ targetMetadata });
      },
      markCommitted: async () => persist({ phase: 'committed' }),
      fileSystem: effectiveFileSystem,
      retry,
    });
    clearTransactionRecords(paths, durability);
    await cleanupAfterCommit(prepared);
    return health;
  } catch (error) {
    if (error?.transactionCommitted) {
      onDiagnostic(
        `Update committed with cleanup diagnostics: ${error.message}`
      );
      throw error;
    }
    if (error?.recoveryCompleted) {
      if (paths.metadataPath) {
        writeDurableVersionMetadata({
          path: paths.metadataPath,
          version: previousVersion,
          durability,
        });
      }
      await restoreMetadata({ previousVersion, prepared });
      clearTransactionRecords(paths, durability);
    }
    throw error;
  }
}

export async function recoverInterruptedProductionUpdate({
  paths,
  terminateOwnedProcess,
  processIsAlive = async () => false,
  discoverOwnedProcesses = async () => [],
  resolveLaunchExecutable = ({ workingPath }) => workingPath,
  launchAndWaitForHealth,
  restoreMetadata = async () => {},
  onDiagnostic = () => {},
  durability = createProductionDurabilityAdapter(),
  fileSystem,
  retry,
  journalFault = () => {},
  recoveryFault = () => {},
}) {
  const effectiveFileSystem = fileSystem ?? transactionFilesystem(durability);
  const read = readValidatedTransactionJournal({
    journalPath: paths.journalPath,
    stateRoot: paths.stateRoot,
    expectedPaths: paths,
  });
  for (const diagnostic of read.diagnostics) onDiagnostic(diagnostic);
  let journal = read.journal;
  if (!journal) {
    const ownership = readBackupOwnership(paths);
    if (!ownership) {
      if (existsSync(paths.backupPath) || existsSync(paths.retiredBackupPath)) {
        const error = new Error(
          'Malformed transaction journal and no valid ownership manifest; preserving transaction backups for manual recovery'
        );
        onDiagnostic(error.message);
        throw error;
      }
      return { recovered: false, committed: false };
    }
    journal = {
      ...ownership,
      version: JOURNAL_VERSION,
      phase: existsSync(paths.retiredBackupPath)
        ? 'committed'
        : ownership.phase,
    };
    onDiagnostic(
      'Recovered transaction ownership from the durable backup manifest after journal corruption'
    );
  }

  const persist = (next) => {
    journal = { ...journal, ...next };
    writeTransactionJournal({
      journalPath: paths.journalPath,
      stateRoot: paths.stateRoot,
      journal,
      fault: journalFault,
      durability,
    });
    writeBackupOwnership(paths, journal, journalFault, durability);
  };

  const previousMetadata = metadataRecord(journal.previousVersion);
  const finalizeRestoredMetadata = async () => {
    if (paths.metadataPath) {
      verifyDurableVersionMetadata({
        path: paths.metadataPath,
        expected: previousMetadata,
        repair: true,
        durability,
      });
    }
    await restoreMetadata({
      previousVersion: journal.previousVersion,
      targetVersion: journal.targetVersion,
    });
    recoveryFault('after-metadata-repair');
  };

  const restoredPhase = [
    'restored',
    'recovery-active',
    'recovery-launched',
    'recovery-healthy',
  ].includes(journal.phase);

  if (
    journal.phase === 'recovery-healthy' &&
    journal.activeProcess &&
    journal.verifiedHealth
  ) {
    verifyInstallationManifest(paths.workingPath, journal.backupManifest);
    await finalizeRestoredMetadata();
    if (await processIsAlive(journal.activeProcess)) {
      const recoveryHealth = journal.verifiedHealth;
      recoveryFault('before-clear');
      clearTransactionRecords(paths, durability);
      return { recovered: true, committed: false, recoveryHealth };
    }
  }

  if (journal.activeProcess) {
    await stopOwnedProcess({
      expectedIdentity: journal.activeProcess,
      terminateOwnedProcess,
    });
  }
  await reconcileLaunchIntent({
    journal,
    discoverOwnedProcesses,
    terminateOwnedProcess,
  });

  let backupPresent = effectiveFileSystem.exists(paths.backupPath);
  let retiredPresent = effectiveFileSystem.exists(paths.retiredBackupPath);
  const retiredConfirmationPath =
    effectiveFileSystem.getRenameConfirmationPath?.(paths.retiredBackupPath);
  const retirementConfirmationPending =
    typeof retiredConfirmationPath === 'string' &&
    effectiveFileSystem.exists(retiredConfirmationPath);
  if (
    !backupPresent &&
    (retiredPresent || retirementConfirmationPending) &&
    journal.targetMetadata &&
    journal.verifiedHealth
  ) {
    confirmAppliedTransactionRename({
      fileSystem: effectiveFileSystem,
      sourcePath: paths.backupPath,
      destinationPath: paths.retiredBackupPath,
      expectedManifest: journal.backupManifest,
    });
    retiredPresent = true;
  }
  if (journal.phase === 'prepared' && !backupPresent && !retiredPresent) {
    verifyInstallationManifest(paths.workingPath, journal.backupManifest);
    verifyInstallationManifest(
      journal.candidatePath,
      journal.candidateManifest
    );
    rmSync(journal.candidatePath, { recursive: true, force: true });
    durability.syncDirectories([dirname(journal.candidatePath)]);
    clearTransactionRecords(paths, durability);
    return { recovered: false, committed: false, preparedDiscarded: true };
  }

  if (!backupPresent && (journal.phase === 'committed' || retiredPresent)) {
    if (!existsSync(paths.workingPath)) {
      throw new Error('Committed candidate installation is missing');
    }
    verifyInstallationManifest(paths.workingPath, journal.candidateManifest);
    if (!journal.targetMetadata || !journal.verifiedHealth) {
      throw new Error(
        'Retired backup is not sufficient commit proof without durable target metadata and verified Startup Health'
      );
    }
    if (paths.metadataPath) {
      verifyDurableVersionMetadata({
        path: paths.metadataPath,
        expected: journal.targetMetadata,
        repair: true,
        durability,
      });
    }
    if (retiredPresent) {
      try {
        rmSync(paths.retiredBackupPath, { recursive: true, force: true });
        durability.syncDirectories([dirname(paths.retiredBackupPath)]);
      } catch (error) {
        onDiagnostic(
          `Retired backup cleanup remains pending: ${error.message}`
        );
      }
    }
    clearTransactionRecords(paths, durability);
    return { recovered: false, committed: true };
  }

  let restored = false;
  if (backupPresent) {
    verifyInstallationManifest(paths.backupPath, journal.backupManifest);
    restored = await restoreInterruptedTransaction({
      workingPath: paths.workingPath,
      backupPath: paths.backupPath,
      expectedBackupManifest: journal.backupManifest,
      beforeRestore: async () => ({ processStopped: true }),
      fileSystem: effectiveFileSystem,
      retry,
    });
    if (!restored) {
      throw new Error(
        'Interrupted transaction did not restore Last Known-Good'
      );
    }
    persist({
      phase: 'restored',
      activeProcess: undefined,
      verifiedHealth: undefined,
      launchIntent: undefined,
    });
    recoveryFault('after-restore-persist');
  } else {
    try {
      verifyInstallationManifest(paths.workingPath, journal.backupManifest);
    } catch (error) {
      throw new Error(
        'Interrupted pre-commit transaction has no immutable backup and the working installation is not verified Last Known-Good; preserving state for diagnostics',
        { cause: error }
      );
    }
    confirmAppliedTransactionRename({
      fileSystem: effectiveFileSystem,
      sourcePath: paths.backupPath,
      destinationPath: paths.workingPath,
      expectedManifest: journal.backupManifest,
    });
    if (!restoredPhase) {
      onDiagnostic(
        'Reconciled a legacy post-restore crash from the exact Last Known-Good manifest'
      );
    }
    persist({
      phase: 'restored',
      activeProcess: undefined,
      verifiedHealth: undefined,
      launchIntent: undefined,
    });
    recoveryFault('after-restore-persist');
    restored = true;
  }

  await finalizeRestoredMetadata();

  let recoveryHealth;
  if (launchAndWaitForHealth) {
    const launchIntent = buildLaunchIntent({
      role: 'recovery',
      resolvedLaunch: await resolveLaunchExecutable({
        recovery: true,
        workingPath: paths.workingPath,
        transactionToken: journal.transactionToken,
      }),
      transactionToken: journal.transactionToken,
      installationManifest: journal.backupManifest,
    });
    persist({ launchIntent });
    const result = await launchAndWaitForHealth({
      recovery: true,
      workingPath: paths.workingPath,
      transactionToken: journal.transactionToken,
      launchIntent,
      onProcessStarted: (identity) => {
        if (
          !validIdentity(identity) ||
          identity.transactionToken !== journal.transactionToken
        ) {
          throw new Error('Recovery process identity is not transaction-bound');
        }
        persist({ phase: 'recovery-launched', activeProcess: identity });
        recoveryFault('after-recovery-launch');
      },
    });
    const bound = validBoundLaunch(result, journal.transactionToken);
    if (
      !journal.activeProcess ||
      !identitiesMatch(journal.activeProcess, bound.identity)
    ) {
      throw new Error(
        'Recovery Startup Health disagrees with the durable process identity'
      );
    }
    recoveryHealth = bound.health;
    persist({ phase: 'recovery-healthy', verifiedHealth: recoveryHealth });
    recoveryFault('after-recovery-health');
  }
  recoveryFault('before-clear');
  clearTransactionRecords(paths, durability);
  return { recovered: restored, committed: false, recoveryHealth };
}
