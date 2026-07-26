import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { blake2b } from 'blakejs';

function parseDigest(digest) {
  if (typeof digest !== 'string') return null;
  const [algorithm, value, extra] = digest.trim().split(':');
  if (
    extra !== undefined ||
    !['sha256', 'sha384', 'sha512'].includes(algorithm)
  ) {
    return null;
  }
  const lengths = { sha256: 64, sha384: 96, sha512: 128 };
  if (!new RegExp(`^[a-fA-F0-9]{${lengths[algorithm]}}$`).test(value ?? '')) {
    return null;
  }
  return { algorithm, value: value.toLowerCase() };
}

async function hashFile(filePath, algorithm) {
  return createHash(algorithm).update(readFileSync(filePath)).digest('hex');
}

export async function verifyReleaseArtifact(
  artifactPath,
  expected,
  validateContent = async () => {}
) {
  if (!Number.isSafeInteger(expected?.size) || expected.size <= 0) {
    throw new Error('Release artifact authoritative size is required');
  }
  const digest = parseDigest(expected.digest);
  if (!digest) {
    throw new Error('Release artifact authoritative digest is required');
  }
  const actualSize = statSync(artifactPath).size;
  if (actualSize !== expected.size) {
    throw new Error(
      `Release artifact size mismatch: expected ${expected.size}, got ${actualSize}`
    );
  }
  const actualDigest = await hashFile(artifactPath, digest.algorithm);
  if (actualDigest !== digest.value) {
    throw new Error(`Release artifact digest mismatch for ${digest.algorithm}`);
  }
  await validateContent(artifactPath);
}

export async function stageTransactionalCandidate({
  workingPath,
  candidatePath,
  build,
  validate = async () => {},
}) {
  if (!existsSync(workingPath)) {
    throw new Error('Working installation is missing');
  }
  if (resolve(candidatePath) === resolve(workingPath)) {
    throw new Error('Candidate path must differ from working installation');
  }
  mkdirSync(dirname(candidatePath), { recursive: true });
  if (
    statSync(dirname(workingPath)).dev !== statSync(dirname(candidatePath)).dev
  ) {
    throw new Error('Candidate must be staged on the working filesystem');
  }
  if (existsSync(candidatePath)) {
    throw new Error('Candidate staging path already exists');
  }
  try {
    await build(candidatePath);
    if (!existsSync(candidatePath)) {
      throw new Error('Candidate materialization produced no installation');
    }
    await validate(candidatePath);
    return candidatePath;
  } catch (error) {
    rmSync(candidatePath, { recursive: true, force: true });
    throw error;
  }
}

export async function stageVerifiedDownload({
  workingPath,
  stagingDirectory,
  expected,
  download,
  validateContent,
}) {
  mkdirSync(stagingDirectory, { recursive: true });
  const candidatePath = join(
    stagingDirectory,
    `${Date.now()}-${randomUUID()}.candidate`
  );
  if (resolve(candidatePath) === resolve(workingPath)) {
    throw new Error(
      'Candidate staging path must differ from working installation'
    );
  }
  try {
    await download(candidatePath);
    await verifyReleaseArtifact(candidatePath, expected, validateContent);
    return candidatePath;
  } catch (error) {
    rmSync(candidatePath, { force: true });
    throw error;
  }
}

function normalizeVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '');
}

export function assertIncrementalVersions(
  metadata,
  installedVersion,
  targetVersion
) {
  if (
    normalizeVersion(metadata?.fromVersion) !==
    normalizeVersion(installedVersion)
  ) {
    throw new Error(
      'Incremental patch source version does not match installation'
    );
  }
  if (
    normalizeVersion(metadata?.toVersion) !== normalizeVersion(targetVersion)
  ) {
    throw new Error('Incremental patch target version does not match release');
  }
}

function validateBlockmapShape(file) {
  if (!file || !Array.isArray(file.sizes) || !Array.isArray(file.checksums)) {
    throw new Error('Invalid blockmap payload');
  }
  if (file.sizes.length === 0 || file.sizes.length !== file.checksums.length) {
    throw new Error('Invalid blockmap block count');
  }
  const offset = file.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid blockmap offset');
  }
  for (let index = 0; index < file.sizes.length; index += 1) {
    if (!Number.isSafeInteger(file.sizes[index]) || file.sizes[index] <= 0) {
      throw new Error(`Invalid blockmap block size at index ${index}`);
    }
    if (
      typeof file.checksums[index] !== 'string' ||
      !/^[A-Za-z0-9+/]{24}$/.test(file.checksums[index])
    ) {
      throw new Error(`Invalid blockmap checksum at index ${index}`);
    }
  }
  return offset;
}

function blockChecksum(buffer) {
  return Buffer.from(blake2b(buffer, undefined, 18)).toString('base64');
}

export async function verifyBlockmapFile(artifactPath, file) {
  const offset = validateBlockmapShape(file);
  const stat = statSync(artifactPath);
  const expectedSize =
    offset + file.sizes.reduce((total, size) => total + size, 0);
  if (stat.size !== expectedSize) {
    throw new Error(
      `Blockmap described size mismatch: expected ${expectedSize}, got ${stat.size}`
    );
  }
  const descriptor = openSync(artifactPath, 'r');
  try {
    let readOffset = offset;
    for (let index = 0; index < file.sizes.length; index += 1) {
      const size = file.sizes[index];
      const buffer = Buffer.alloc(size);
      const bytesRead = readSync(descriptor, buffer, 0, size, readOffset);
      if (bytesRead !== size) {
        throw new Error(`Short blockmap read at index ${index}`);
      }
      if (blockChecksum(buffer) !== file.checksums[index]) {
        throw new Error(`Blockmap checksum mismatch at index ${index}`);
      }
      readOffset += size;
    }
  } finally {
    closeSync(descriptor);
  }
}

function readBlockmap(blockmapPath) {
  const value = JSON.parse(
    gunzipSync(readFileSync(blockmapPath)).toString('utf8')
  );
  if (
    value?.version !== '2' ||
    !Array.isArray(value.files) ||
    value.files.length !== 1
  ) {
    throw new Error('Invalid blockmap payload');
  }
  validateBlockmapShape(value.files[0]);
  return value.files[0];
}

export async function applyBlockmapPatch({
  sourceArtifact,
  oldBlockmapPath,
  outputArtifact,
  newBlockmapPath,
  expectedArtifact,
  downloadRange,
  onProgress = () => {},
}) {
  const oldFile = readBlockmap(oldBlockmapPath);
  const newFile = readBlockmap(newBlockmapPath);
  await verifyBlockmapFile(sourceArtifact, oldFile);

  const checksumToBlocks = new Map();
  let oldOffset = oldFile.offset ?? 0;
  for (let index = 0; index < oldFile.checksums.length; index += 1) {
    const key = `${oldFile.checksums[index]}:${oldFile.sizes[index]}`;
    const blocks = checksumToBlocks.get(key) ?? [];
    blocks.push({ offset: oldOffset, size: oldFile.sizes[index] });
    checksumToBlocks.set(key, blocks);
    oldOffset += oldFile.sizes[index];
  }

  mkdirSync(dirname(outputArtifact), { recursive: true });
  rmSync(outputArtifact, { force: true });
  const sourceFd = openSync(sourceArtifact, 'r');
  const outputFd = openSync(outputArtifact, 'w');
  let patchError;
  try {
    let writeOffset = newFile.offset ?? 0;
    if (writeOffset > 0) {
      const header = await downloadRange(0, writeOffset - 1);
      if (header.length !== writeOffset)
        throw new Error('Invalid patch header length');
      writeSync(outputFd, header, 0, header.length, 0);
    }
    for (let index = 0; index < newFile.checksums.length; index += 1) {
      const size = newFile.sizes[index];
      const key = `${newFile.checksums[index]}:${size}`;
      const blocks = checksumToBlocks.get(key);
      const matched = blocks?.pop();
      let block;
      if (matched) {
        block = Buffer.alloc(size);
        const bytesRead = readSync(sourceFd, block, 0, size, matched.offset);
        if (bytesRead !== size)
          throw new Error('Short read from source artifact');
      } else {
        block = Buffer.from(
          await downloadRange(writeOffset, writeOffset + size - 1)
        );
        if (block.length !== size)
          throw new Error('Invalid patch range length');
      }
      if (blockChecksum(block) !== newFile.checksums[index]) {
        throw new Error(`Blockmap checksum mismatch at index ${index}`);
      }
      writeSync(outputFd, block, 0, block.length, writeOffset);
      writeOffset += size;
      onProgress(index + 1, newFile.sizes.length);
    }
  } catch (error) {
    patchError = error;
  } finally {
    closeSync(sourceFd);
    closeSync(outputFd);
  }
  if (patchError) {
    rmSync(outputArtifact, { force: true });
    throw patchError;
  }
  await verifyBlockmapFile(outputArtifact, newFile);
  await verifyReleaseArtifact(outputArtifact, expectedArtifact);
  return outputArtifact;
}

export function createInstallationManifest(root) {
  if (!existsSync(root))
    throw new Error('Installation manifest root is missing');
  const entries = [];
  const visit = (target, relativePath = '.') => {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relativePath,
        type: 'symlink',
        mode: stat.mode & 0o777,
        target: readlinkSync(target),
      });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({
        path: relativePath,
        type: 'directory',
        mode: stat.mode & 0o777,
      });
      for (const name of readdirSync(target).sort()) {
        visit(
          join(target, name),
          relativePath === '.' ? name : `${relativePath}/${name}`
        );
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported installation entry: ${relativePath}`);
    }
    entries.push({
      path: relativePath,
      type: 'file',
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    });
  };
  visit(root);
  return {
    version: 1,
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    entries,
  };
}

export function verifyInstallationManifest(root, expected) {
  if (
    expected?.version !== 1 ||
    typeof expected.digest !== 'string' ||
    !Array.isArray(expected.entries)
  ) {
    throw new Error('Last Known-Good manifest is invalid');
  }
  const actual = createInstallationManifest(root);
  if (actual.digest !== expected.digest) {
    throw new Error('Last Known-Good backup manifest mismatch');
  }
  return actual;
}

function validHealth(value) {
  return (
    value?.version === 1 &&
    value.state === 'interactive' &&
    value.processAlive === true
  );
}

function syncDirectories(paths) {
  if (process.platform === 'win32') {
    throw new Error(
      'Windows directory durability requires the production write-through filesystem adapter'
    );
  }
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

const DEFAULT_TRANSACTION_FILESYSTEM = {
  exists: existsSync,
  rename: renameSync,
  remove: (target) => rmSync(target, { recursive: true, force: true }),
  device: (target) => statSync(target).dev,
  syncDirectories,
};

function verifyAppliedRename(fileSystem, from, to, expectedManifest) {
  if (fileSystem.exists(from) || !fileSystem.exists(to)) return false;
  if (expectedManifest) verifyInstallationManifest(to, expectedManifest);
  return true;
}

function durableRename(fileSystem, from, to, expectedManifest) {
  const directories = [dirname(from), dirname(to)];
  try {
    const confirmationPath = fileSystem.getRenameConfirmationPath?.(to);
    let renameConfirmed = false;
    if (
      confirmationPath &&
      !fileSystem.exists(to) &&
      fileSystem.exists(confirmationPath)
    ) {
      if (expectedManifest) {
        verifyInstallationManifest(confirmationPath, expectedManifest);
      }
      fileSystem.confirmAppliedRename(to, directories);
      renameConfirmed = true;
    }
    if (!verifyAppliedRename(fileSystem, from, to, expectedManifest)) {
      if (!fileSystem.exists(from)) {
        throw new Error(
          `Durable rename source is missing and destination is not verified: ${from}`
        );
      }
      if (fileSystem.exists(to)) {
        throw new Error(`Durable rename destination already exists: ${to}`);
      }
      if (fileSystem.durableRename) {
        fileSystem.durableRename(from, to, directories);
      } else {
        fileSystem.rename(from, to);
        (fileSystem.syncDirectories ?? syncDirectories)(directories);
      }
    } else if (fileSystem.confirmAppliedRename && !renameConfirmed) {
      fileSystem.confirmAppliedRename(to, directories);
    } else if (!renameConfirmed) {
      (fileSystem.syncDirectories ?? syncDirectories)(directories);
    }
  } catch (error) {
    const confirmationPath = fileSystem.getRenameConfirmationPath?.(to);
    if (
      verifyAppliedRename(fileSystem, from, to, expectedManifest) ||
      (confirmationPath && fileSystem.exists(confirmationPath))
    ) {
      error.durableRenameApplied = true;
    }
    throw error;
  }
  if (!verifyAppliedRename(fileSystem, from, to, expectedManifest)) {
    throw new Error(
      `Durable rename did not produce the expected destination: ${to}`
    );
  }
}

export function confirmAppliedTransactionRename({
  fileSystem,
  sourcePath,
  destinationPath,
  expectedManifest,
}) {
  durableRename(fileSystem, sourcePath, destinationPath, expectedManifest);
}

function transactionError(label, error) {
  return new Error(
    `${label}: ${error instanceof Error ? error.message : error}`,
    {
      cause: error,
    }
  );
}

function errorChainHas(error, property) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    if (current[property] === true) return true;
    visited.add(current);
    current = current.cause;
  }
  return false;
}

function isRetryableFilesystemError(error) {
  return (
    errorChainHas(error, 'durableRenameApplied') ||
    ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)
  );
}

async function retryFilesystemOperation(label, operation, retry) {
  let lastError;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFilesystemError(error) || attempt === retry.attempts) {
        break;
      }
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, retry.delayMs * attempt)
      );
    }
  }
  throw transactionError(label, lastError);
}

function assertSameFilesystem(
  workingPath,
  candidatePath,
  backupPath,
  fileSystem
) {
  const workingDevice = fileSystem.device(dirname(workingPath));
  const candidateDevice = fileSystem.device(dirname(candidatePath));
  const backupDevice = fileSystem.device(dirname(backupPath));
  if (workingDevice !== candidateDevice || workingDevice !== backupDevice) {
    throw new Error(
      'Candidate, working installation, and backup must share one filesystem'
    );
  }
}

export async function restoreInterruptedTransaction({
  workingPath,
  backupPath,
  expectedBackupManifest,
  beforeRestore = async () => ({ processStopped: true }),
  fileSystem = DEFAULT_TRANSACTION_FILESYSTEM,
  retry = { attempts: 6, delayMs: 100 },
}) {
  const errors = [];
  let processStopped = false;
  try {
    const result = await beforeRestore();
    processStopped = result === true || result?.processStopped === true;
    if (!processStopped) {
      throw new Error('Interrupted candidate process stop was not verified');
    }
  } catch (error) {
    errors.push(
      transactionError('Interrupted candidate termination failed', error)
    );
  }

  if (!fileSystem.exists(backupPath)) {
    if (errors.length === 0) return false;
    const error = new AggregateError(
      errors,
      `Interrupted update reconciliation diagnostics: ${errors
        .map((value) => value.message)
        .join('; ')}`
    );
    error.recoveryCompleted = false;
    error.restorationCompleted = false;
    error.processStopped = processStopped;
    error.backupPreserved = false;
    throw error;
  }

  let backupVerified = false;
  try {
    if (!expectedBackupManifest) {
      throw new Error('Last Known-Good manifest is required before rollback');
    }
    verifyInstallationManifest(backupPath, expectedBackupManifest);
    backupVerified = true;
  } catch (error) {
    errors.push(
      transactionError('Last Known-Good manifest verification failed', error)
    );
  }

  if (backupVerified && fileSystem.exists(workingPath)) {
    try {
      await retryFilesystemOperation(
        'Unable to remove uncommitted candidate during interrupted-update recovery',
        () => fileSystem.remove(workingPath),
        retry
      );
    } catch (error) {
      errors.push(error);
    }
  }
  let restored = false;
  if (backupVerified && !fileSystem.exists(workingPath)) {
    try {
      await retryFilesystemOperation(
        'Unable to restore Last Known-Good after interrupted update',
        () =>
          durableRename(
            fileSystem,
            backupPath,
            workingPath,
            expectedBackupManifest
          ),
        retry
      );
      verifyInstallationManifest(workingPath, expectedBackupManifest);
      restored = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const error = new AggregateError(
      errors,
      `Interrupted update recovery diagnostics: ${errors
        .map((value) => value.message)
        .join('; ')}`
    );
    error.recoveryCompleted = restored && processStopped;
    error.restorationCompleted = restored;
    error.processStopped = processStopped;
    error.backupPreserved = fileSystem.exists(backupPath);
    error.backupVerified = backupVerified;
    throw error;
  }
  return restored;
}

export async function transactionalReplaceAndRequireHealth({
  workingPath,
  candidatePath,
  backupPath,
  retiredBackupPath = `${backupPath}.retired-${randomUUID()}`,
  expectedBackupManifest = createInstallationManifest(workingPath),
  expectedCandidateManifest = createInstallationManifest(candidatePath),
  launchAndWaitForHealth,
  beforeRecovery = async () => ({ processStopped: true }),
  commitCandidate = async () => {},
  markCommitted = async () => {},
  markRestored = async () => {},
  afterRestore = async () => {},
  fileSystem = DEFAULT_TRANSACTION_FILESYSTEM,
  retry = { attempts: 6, delayMs: 100 },
}) {
  if (!fileSystem.exists(workingPath))
    throw new Error('Working installation is missing');
  if (!fileSystem.exists(candidatePath))
    throw new Error('Verified candidate is missing');
  assertSameFilesystem(workingPath, candidatePath, backupPath, fileSystem);
  if (
    fileSystem.device(dirname(retiredBackupPath)) !==
    fileSystem.device(dirname(workingPath))
  ) {
    throw new Error('Retired backup must share the working filesystem');
  }
  verifyInstallationManifest(workingPath, expectedBackupManifest);
  if (fileSystem.exists(backupPath) || fileSystem.exists(retiredBackupPath)) {
    throw new Error(
      'Last Known-Good backup state already exists; interrupted transaction must be reconciled first'
    );
  }

  await retryFilesystemOperation(
    'Unable to retain Last Known-Good installation',
    () =>
      durableRename(
        fileSystem,
        workingPath,
        backupPath,
        expectedBackupManifest
      ),
    retry
  );

  let candidateError;
  let health;
  let metadataCommitted = false;
  try {
    await retryFilesystemOperation(
      'Unable to atomically install verified candidate',
      () =>
        durableRename(
          fileSystem,
          candidatePath,
          workingPath,
          expectedCandidateManifest
        ),
      retry
    );
    health = await launchAndWaitForHealth({
      recovery: false,
      workingPath,
    });
    if (!validHealth(health))
      throw new Error('Candidate Startup Health is invalid');
    await commitCandidate(health);
    metadataCommitted = true;
    verifyInstallationManifest(backupPath, expectedBackupManifest);
    await retryFilesystemOperation(
      'Unable to atomically retire Last Known-Good backup',
      () =>
        durableRename(
          fileSystem,
          backupPath,
          retiredBackupPath,
          expectedBackupManifest
        ),
      retry
    );
  } catch (error) {
    if (
      metadataCommitted &&
      fileSystem.exists(retiredBackupPath) &&
      !errorChainHas(error, 'durableRenameApplied')
    ) {
      error.transactionCommitted = true;
      error.backupRetired = true;
      error.health = health;
      error.retiredBackupPreserved = true;
      throw error;
    }
    candidateError = error;
  }

  if (!candidateError) {
    try {
      await markCommitted(health);
    } catch (error) {
      error.transactionCommitted = true;
      error.backupRetired = fileSystem.exists(retiredBackupPath);
      error.health = health;
      error.retiredBackupPreserved = fileSystem.exists(retiredBackupPath);
      throw error;
    }
    try {
      await retryFilesystemOperation(
        'Unable to delete retired Last Known-Good backup',
        () => fileSystem.remove(retiredBackupPath),
        retry
      );
    } catch (error) {
      const cleanupError = transactionError(
        'Transaction committed; post-commit backup cleanup failed',
        error
      );
      cleanupError.transactionCommitted = true;
      cleanupError.health = health;
      cleanupError.retiredBackupPreserved =
        fileSystem.exists(retiredBackupPath);
      throw cleanupError;
    }
    return health;
  }

  const recoveryErrors = [];
  let processStopped = false;
  try {
    const stopResult = await beforeRecovery();
    processStopped = stopResult === true || stopResult?.processStopped === true;
    if (!processStopped) {
      throw new Error('Candidate process stop was not verified');
    }
  } catch (error) {
    recoveryErrors.push(
      transactionError('Candidate termination failed', error)
    );
  }

  let backupVerified = false;
  if (fileSystem.exists(backupPath)) {
    try {
      verifyInstallationManifest(backupPath, expectedBackupManifest);
      backupVerified = true;
    } catch (error) {
      recoveryErrors.push(
        transactionError('Last Known-Good manifest verification failed', error)
      );
    }
  } else {
    recoveryErrors.push(new Error('Last Known-Good backup is missing'));
  }

  if (backupVerified && fileSystem.exists(workingPath)) {
    try {
      await retryFilesystemOperation(
        'Unable to remove failed candidate',
        () => fileSystem.remove(workingPath),
        retry
      );
    } catch (error) {
      recoveryErrors.push(error);
    }
  }
  let restored = false;
  let restorationFinalized = false;
  if (backupVerified && !fileSystem.exists(workingPath)) {
    try {
      await retryFilesystemOperation(
        'Unable to restore Last Known-Good installation',
        () =>
          durableRename(
            fileSystem,
            backupPath,
            workingPath,
            expectedBackupManifest
          ),
        retry
      );
      verifyInstallationManifest(workingPath, expectedBackupManifest);
      restored = true;
      await markRestored();
      await afterRestore();
      restorationFinalized = true;
    } catch (error) {
      recoveryErrors.push(error);
    }
  } else if (backupVerified) {
    recoveryErrors.push(
      new Error('Failed candidate still occupies the working installation path')
    );
  }

  let recoveryHealth;
  if (restorationFinalized && processStopped) {
    try {
      recoveryHealth = await launchAndWaitForHealth({
        recovery: true,
        workingPath,
      });
      if (!validHealth(recoveryHealth)) {
        throw new Error('Last Known-Good Startup Health is invalid');
      }
    } catch (error) {
      recoveryErrors.push(
        transactionError('Last Known-Good health verification failed', error)
      );
    }
  }

  const recoveryCompleted =
    processStopped &&
    !fileSystem.exists(backupPath) &&
    fileSystem.exists(workingPath) &&
    validHealth(recoveryHealth);
  const errors = [candidateError, ...recoveryErrors].filter(Boolean);
  const resultError =
    errors.length === 1
      ? candidateError
      : new AggregateError(
          errors,
          `Candidate update failed; recovery diagnostics: ${errors
            .map((error) => error.message)
            .join('; ')}`,
          { cause: candidateError }
        );
  if (resultError && typeof resultError === 'object') {
    resultError.recoveryCompleted = recoveryCompleted;
    resultError.recoveryHealth = recoveryHealth;
    resultError.processStopped = processStopped;
    resultError.backupPreserved = fileSystem.exists(backupPath);
    resultError.backupVerified = backupVerified;
    resultError.transactionCommitted = false;
  }
  throw resultError;
}

export function resolveApplicationLauncher(installationDirectory, platform) {
  const launcherName =
    platform === 'win32'
      ? 'OpenGameInstaller.exe'
      : 'OpenGameInstaller.AppImage';
  const launcher = join(installationDirectory, launcherName);
  if (!existsSync(launcher)) {
    throw new Error(
      `Required application launcher is missing: ${launcherName}`
    );
  }
  return launcher;
}
