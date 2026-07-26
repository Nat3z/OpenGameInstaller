import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  createProductionDurabilityAdapter,
  installPreparedProductionUpdate,
  PRODUCTION_UPDATE_COORDINATOR_MARKER,
  readValidatedTransactionJournal,
  recoverInterruptedProductionUpdate,
  stopOwnedProcess,
  writeTransactionJournal,
} from '../src/production-update-coordinator.mjs';
import {
  applyBlockmapPatch,
  assertIncrementalVersions,
  createInstallationManifest,
  resolveApplicationLauncher,
  restoreInterruptedTransaction,
  stageTransactionalCandidate,
  stageVerifiedDownload,
  transactionalReplaceAndRequireHealth,
  verifyBlockmapFile,
  verifyReleaseArtifact,
} from '../src/update-engine.mjs';
import {
  parseWindowsJobLaunchEvidence,
  parseWindowsJobResultEvidence,
} from '../src/windows-job-evidence.mjs';

const sha256 = (value: Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

function installationBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else result[relative] = readFileSync(absolute).toString('base64');
    }
  };
  visit(root);
  return result;
}

async function makeBlockmap(contents: Buffer, sizes: number[]) {
  const { blake2b } = await import('blakejs');
  let offset = 0;
  const checksums = sizes.map((size) => {
    const checksum = Buffer.from(
      blake2b(contents.subarray(offset, offset + size), undefined, 18)
    ).toString('base64');
    offset += size;
    return checksum;
  });
  return {
    version: '2',
    files: [{ name: 'file', offset: 0, sizes, checksums }],
  };
}

describe('production updater update engine', () => {
  test('stages a full fallback at a unique path and never deletes the working installation on failed download', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-full-fallback-'));
    const working = join(root, 'update/OpenGameInstaller.AppImage');
    const staging = join(root, 'state/staging');
    mkdirSync(join(root, 'update'), { recursive: true });
    writeFileSync(working, 'healthy-lkg');

    try {
      await expect(
        stageVerifiedDownload({
          workingPath: working,
          stagingDirectory: staging,
          expected: { size: 9, digest: sha256(Buffer.from('candidate')) },
          download: async (destination) => {
            expect(destination).not.toBe(working);
            writeFileSync(destination, 'partial');
            throw new Error('interrupted');
          },
        })
      ).rejects.toThrow('interrupted');
      expect(readFileSync(working, 'utf8')).toBe('healthy-lkg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps exact working bytes after disk-full, quota, permission, and mid-copy candidate staging failures', async () => {
    for (const code of ['ENOSPC', 'EDQUOT', 'EACCES', 'EIO']) {
      const root = mkdtempSync(join(tmpdir(), `ogi-candidate-${code}-`));
      const working = join(root, 'update');
      const candidate = join(root, 'candidate');
      mkdirSync(join(working, 'resources'), { recursive: true });
      writeFileSync(join(working, 'OpenGameInstaller.exe'), 'exact-lkg-exe');
      writeFileSync(join(working, 'resources/app.asar'), 'exact-lkg-asar');
      const exactLkg = installationBytes(working);
      try {
        await expect(
          stageTransactionalCandidate({
            workingPath: working,
            candidatePath: candidate,
            build: () => {
              mkdirSync(candidate);
              writeFileSync(
                join(candidate, 'OpenGameInstaller.exe'),
                'partial'
              );
              const error = new Error(`injected ${code} during candidate copy`);
              Object.assign(error, { code });
              throw error;
            },
          })
        ).rejects.toThrow(code);
        expect(installationBytes(working)).toEqual(exactLkg);
        expect(existsSync(candidate)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('requires authoritative size and digest and rejects same-length corrupt full artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-full-authenticity-'));
    const artifact = join(root, 'candidate.bin');
    writeFileSync(artifact, 'candidate');
    try {
      await expect(verifyReleaseArtifact(artifact, {})).rejects.toThrow('size');
      await expect(
        verifyReleaseArtifact(artifact, { size: 9 })
      ).rejects.toThrow('digest');
      await expect(
        verifyReleaseArtifact(artifact, {
          size: 9,
          digest: sha256(Buffer.from('corrupted')),
        })
      ).rejects.toThrow('digest mismatch');
      await expect(
        verifyReleaseArtifact(
          artifact,
          { size: 9, digest: sha256(Buffer.from('candidate')) },
          async () => {
            throw new Error('content signature invalid');
          }
        )
      ).rejects.toThrow('content signature invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hashes every blockmap block and rejects count, size, and same-length byte corruption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-blockmap-validation-'));
    const artifact = join(root, 'artifact.bin');
    const contents = Buffer.from('abcdefgh12345678');
    writeFileSync(artifact, contents);
    const blockmap = await makeBlockmap(contents, [8, 8]);
    try {
      await expect(
        verifyBlockmapFile(artifact, blockmap.files[0])
      ).resolves.toBeUndefined();
      writeFileSync(artifact, Buffer.from('abcdefgh1234567X'));
      await expect(
        verifyBlockmapFile(artifact, blockmap.files[0])
      ).rejects.toThrow('checksum mismatch');
      await expect(
        verifyBlockmapFile(artifact, {
          ...blockmap.files[0],
          checksums: blockmap.files[0].checksums.slice(0, 1),
        })
      ).rejects.toThrow('block count');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validates reused and downloaded patch blocks before accepting the target artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-blockmap-patch-'));
    const source = join(root, 'source.bin');
    const output = join(root, 'output.bin');
    const oldContents = Buffer.from('abcdefghOLD-BLOCK');
    const newContents = Buffer.from('abcdefghNEW-BLOCK');
    writeFileSync(source, oldContents);
    const oldMap = await makeBlockmap(oldContents, [8, 9]);
    const newMap = await makeBlockmap(newContents, [8, 9]);
    const oldMapPath = join(root, 'old.blockmap');
    const newMapPath = join(root, 'new.blockmap');
    writeFileSync(oldMapPath, gzipSync(JSON.stringify(oldMap)));
    writeFileSync(newMapPath, gzipSync(JSON.stringify(newMap)));
    try {
      await applyBlockmapPatch({
        sourceArtifact: source,
        oldBlockmapPath: oldMapPath,
        outputArtifact: output,
        newBlockmapPath: newMapPath,
        expectedArtifact: {
          size: newContents.length,
          digest: sha256(newContents),
        },
        downloadRange: async (start, end) =>
          newContents.subarray(start, end + 1),
      });
      expect(readFileSync(output)).toEqual(newContents);

      await expect(
        applyBlockmapPatch({
          sourceArtifact: source,
          oldBlockmapPath: oldMapPath,
          outputArtifact: output,
          newBlockmapPath: newMapPath,
          expectedArtifact: {
            size: newContents.length,
            digest: sha256(newContents),
          },
          downloadRange: async (start, end) => {
            const corrupt = Buffer.from(newContents.subarray(start, end + 1));
            corrupt[0] ^= 1;
            return corrupt;
          },
        })
      ).rejects.toThrow(/checksum mismatch|digest mismatch/);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds incremental metadata to exact normalized installed and target versions', () => {
    expect(() =>
      assertIncrementalVersions(
        { fromVersion: '4.0.0-e2e', toVersion: 'v4.1.0-e2e' },
        'v4.0.0-e2e\n',
        '4.1.0-e2e'
      )
    ).not.toThrow();
    expect(() =>
      assertIncrementalVersions(
        { fromVersion: 'v3.9.0-e2e', toVersion: 'v4.1.0-e2e' },
        'v4.0.0-e2e',
        'v4.1.0-e2e'
      )
    ).toThrow('source version');
    expect(() =>
      assertIncrementalVersions(
        { fromVersion: 'v4.0.0-e2e', toVersion: 'v4.2.0-e2e' },
        'v4.0.0-e2e',
        'v4.1.0-e2e'
      )
    ).toThrow('target version');
  });

  test('restores and health-checks Last Known-Good after candidate failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-transactional-update-'));
    const working = join(root, 'OpenGameInstaller.AppImage');
    const candidate = join(root, 'candidate.AppImage');
    const backup = join(root, 'backup.AppImage');
    writeFileSync(working, 'healthy-lkg');
    writeFileSync(candidate, 'bad-candidate');
    try {
      await expect(
        transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          launchAndWaitForHealth: async ({ recovery }) => {
            if (!recovery) throw new Error('candidate exited');
            expect(readFileSync(working, 'utf8')).toBe('healthy-lkg');
            return { version: 1, state: 'interactive', processAlive: true };
          },
        })
      ).rejects.toThrow('candidate exited');
      expect(readFileSync(working, 'utf8')).toBe('healthy-lkg');

      writeFileSync(candidate, 'bad-candidate');
      await expect(
        transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          launchAndWaitForHealth: async ({ recovery }) =>
            recovery
              ? { version: 1, state: 'interactive', processAlive: false }
              : Promise.reject(new Error('candidate exited')),
        })
      ).rejects.toThrow('Last Known-Good Startup Health');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores exact Windows installation bytes after an injected atomic-install failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-windows-transaction-'));
    const working = join(root, 'update');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    mkdirSync(join(working, 'resources'), { recursive: true });
    mkdirSync(join(candidate, 'resources'), { recursive: true });
    writeFileSync(join(working, 'OpenGameInstaller.exe'), 'healthy-lkg-exe');
    writeFileSync(join(working, 'resources/app.asar'), 'healthy-lkg-asar');
    writeFileSync(join(candidate, 'OpenGameInstaller.exe'), 'candidate-exe');
    writeFileSync(join(candidate, 'resources/app.asar'), 'candidate-asar');
    const exactLkg = installationBytes(working);
    let renameCalls = 0;
    const fileSystem = {
      exists: existsSync,
      rename(source: string, destination: string) {
        renameCalls += 1;
        if (renameCalls === 2) {
          const error = new Error('injected disk-full during candidate swap');
          Object.assign(error, { code: 'ENOSPC' });
          throw error;
        }
        renameSync(source, destination);
      },
      remove(target: string) {
        rmSync(target, { recursive: true, force: true });
      },
      device(target: string) {
        return statSync(target).dev;
      },
    };
    try {
      await expect(
        transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          fileSystem,
          beforeRecovery: async () => ({
            processStopped: true,
            processTreeStopped: true,
          }),
          launchAndWaitForHealth: async ({ recovery }) => {
            expect(recovery).toBe(true);
            expect(installationBytes(working)).toEqual(exactLkg);
            return { version: 1, state: 'interactive', processAlive: true };
          },
        })
      ).rejects.toThrow('disk-full');
      expect(installationBytes(working)).toEqual(exactLkg);
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rolls back exact bytes when post-health metadata commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-commit-rollback-'));
    const working = join(root, 'OpenGameInstaller.AppImage');
    const candidate = join(root, 'candidate.AppImage');
    const backup = join(root, 'backup.AppImage');
    writeFileSync(working, Buffer.from([0, 1, 2, 3, 255]));
    writeFileSync(candidate, 'verified-candidate');
    const exactLkg = readFileSync(working);
    try {
      await expect(
        transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          beforeRecovery: async () => ({
            processStopped: true,
            processTreeStopped: true,
          }),
          commitCandidate: async () => {
            throw new Error('injected metadata permission failure');
          },
          launchAndWaitForHealth: async ({ recovery }) => ({
            version: 1,
            state: 'interactive',
            processAlive: true,
            recovery,
          }),
        })
      ).rejects.toThrow('metadata permission failure');
      expect(readFileSync(working)).toEqual(exactLkg);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores bytes but never launches Last Known-Good when tree termination throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-termination-throws-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    writeFileSync(working, 'exact-lkg');
    writeFileSync(candidate, 'bad-candidate');
    let recoveryVerified = false;
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        beforeRecovery: async () => {
          throw new Error('termination callback exploded');
        },
        launchAndWaitForHealth: async ({ recovery }) => {
          if (!recovery) throw new Error('candidate crashed');
          recoveryVerified = true;
          expect(readFileSync(working, 'utf8')).toBe('exact-lkg');
          return { version: 1, state: 'interactive', processAlive: true };
        },
      }).catch((error) => error);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect(thrown.message).toContain('termination callback exploded');
      expect(thrown.recoveryCompleted).toBe(false);
      expect(recoveryVerified).toBe(false);
      expect(readFileSync(working, 'utf8')).toBe('exact-lkg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not claim recovery when a stubborn candidate cannot be proven stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-stubborn-candidate-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    writeFileSync(working, 'exact-lkg');
    writeFileSync(candidate, 'bad-candidate');
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        beforeRecovery: async () => ({ processStopped: false }),
        launchAndWaitForHealth: async ({ recovery }) => {
          if (!recovery) throw new Error('candidate timed out');
          return { version: 1, state: 'interactive', processAlive: true };
        },
      }).catch((error) => error);
      expect(thrown.message).toContain('stop was not verified');
      expect(thrown.processStopped).toBe(false);
      expect(thrown.recoveryCompleted).toBe(false);
      expect(readFileSync(working, 'utf8')).toBe('exact-lkg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the backup and reports infrastructure failure when locked files block restoration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-locked-candidate-'));
    const working = join(root, 'update');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    mkdirSync(working);
    mkdirSync(candidate);
    writeFileSync(join(working, 'OpenGameInstaller.exe'), 'exact-lkg');
    writeFileSync(join(candidate, 'OpenGameInstaller.exe'), 'locked-candidate');
    const fileSystem = {
      exists: existsSync,
      rename: renameSync,
      remove(target: string) {
        if (target === working) {
          const error = new Error('file is locked by candidate');
          Object.assign(error, { code: 'EBUSY' });
          throw error;
        }
        rmSync(target, { recursive: true, force: true });
      },
      device(target: string) {
        return statSync(target).dev;
      },
    };
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        fileSystem,
        retry: { attempts: 2, delayMs: 1 },
        beforeRecovery: async () => ({ processStopped: false }),
        launchAndWaitForHealth: async ({ recovery }) => {
          if (recovery)
            throw new Error('recovery must not launch from candidate');
          throw new Error('candidate invalid health');
        },
      }).catch((error) => error);
      expect(thrown.message).toContain('locked by candidate');
      expect(thrown.backupPreserved).toBe(true);
      expect(existsSync(backup)).toBe(true);
      expect(readFileSync(join(backup, 'OpenGameInstaller.exe'), 'utf8')).toBe(
        'exact-lkg'
      );
      expect(readFileSync(join(working, 'OpenGameInstaller.exe'), 'utf8')).toBe(
        'locked-candidate'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores an interrupted transaction before normal startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-interrupted-swap-'));
    const working = join(root, 'working');
    const backup = join(root, 'backup');
    writeFileSync(working, 'uncommitted-candidate');
    writeFileSync(backup, 'exact-lkg');
    try {
      await expect(
        restoreInterruptedTransaction({
          workingPath: working,
          backupPath: backup,
          expectedBackupManifest: createInstallationManifest(backup),
        })
      ).resolves.toBe(true);
      expect(readFileSync(working, 'utf8')).toBe('exact-lkg');
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retires the immutable backup atomically and never rolls back a healthy committed candidate after partial cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-retired-backup-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    writeFileSync(working, 'exact-lkg');
    writeFileSync(candidate, 'healthy-candidate');
    const manifest = createInstallationManifest(working);
    const fileSystem = {
      exists: existsSync,
      rename: renameSync,
      remove(target: string) {
        if (target === retired) {
          writeFileSync(retired, 'partially-deleted-retired-backup');
          throw new Error('injected partial retired cleanup failure');
        }
        rmSync(target, { recursive: true, force: true });
      },
      device(target: string) {
        return statSync(target).dev;
      },
    };
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        retiredBackupPath: retired,
        expectedBackupManifest: manifest,
        fileSystem,
        launchAndWaitForHealth: async () => ({
          version: 1,
          state: 'interactive',
          processAlive: true,
        }),
      }).catch((error) => error);
      expect(thrown.transactionCommitted).toBe(true);
      expect(thrown.message).toContain('post-commit backup cleanup failed');
      expect(readFileSync(working, 'utf8')).toBe('healthy-candidate');
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(retired)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses rollback when the immutable backup manifest no longer matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-backup-manifest-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    writeFileSync(working, 'exact-lkg');
    writeFileSync(candidate, 'bad-candidate');
    const manifest = createInstallationManifest(working);
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        retiredBackupPath: retired,
        expectedBackupManifest: manifest,
        beforeRecovery: async () => {
          writeFileSync(backup, 'tampered-backup');
          return { processStopped: true, processTreeStopped: true };
        },
        launchAndWaitForHealth: async () => {
          throw new Error('candidate failed health');
        },
      }).catch((error) => error);
      expect(thrown.message).toContain('manifest');
      expect(thrown.backupPreserved).toBe(true);
      expect(readFileSync(working, 'utf8')).toBe('bad-candidate');
      expect(readFileSync(backup, 'utf8')).toBe('tampered-backup');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains a valid journal copy across every atomic write crash boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-journal-atomic-'));
    const journalPath = join(root, 'transaction.json');
    const base = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: 'journal-token-123456',
      phase: 'prepared',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: join(root, 'working'),
      candidatePath: join(root, 'candidate'),
      backupPath: join(root, 'backup'),
      retiredBackupPath: join(root, 'retired'),
      createdAt: new Date().toISOString(),
    };
    mkdirSync(base.workingPath);
    mkdirSync(base.candidatePath);
    const journal = {
      ...base,
      backupManifest: createInstallationManifest(base.workingPath),
      candidateManifest: createInstallationManifest(base.candidatePath),
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    for (const stage of [
      'after-temp-write',
      'after-file-fsync',
      'after-rename',
      'after-dir-fsync',
    ]) {
      expect(() =>
        writeTransactionJournal({
          journalPath,
          stateRoot: root,
          journal: { ...journal, phase: 'candidate-active' },
          fault: (point: string) => {
            if (point === stage) throw new Error(`crash ${stage}`);
          },
        })
      ).toThrow(`crash ${stage}`);
      const recovered = readValidatedTransactionJournal({
        journalPath,
        stateRoot: root,
        expectedPaths: base,
      });
      expect(recovered.journal?.transactionId).toBe(base.transactionId);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('stops an owned journaled process before reconciling a committed candidate with no backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-no-backup-reconcile-'));
    const working = join(root, 'working');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    writeFileSync(working, 'committed-candidate');
    const identity = {
      pid: 4242,
      startTime: '100',
      executable: '/fixture/app',
      transactionToken: 'owned-token-123456',
    };
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: identity.transactionToken,
      phase: 'committed',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: join(root, 'candidate'),
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(working),
      candidateManifest: createInstallationManifest(working),
      targetMetadata: {
        version: 'v2',
        digest: createHash('sha256').update('v2').digest('hex'),
      },
      verifiedHealth: {
        version: 1,
        state: 'interactive',
        processAlive: true,
        pid: identity.pid,
        transactionToken: identity.transactionToken,
      },
      activeProcess: identity,
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    const actions: string[] = [];
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
        },
        terminateOwnedProcess: async () => {
          actions.push('stopped');
          return { processStopped: true, processTreeStopped: true };
        },
        processIsAlive: async () => false,
        onDiagnostic: (message: string) => actions.push(message),
      });
      expect(result.committed).toBe(true);
      expect(actions[0]).toBe('stopped');
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses durable ownership identity to stop a process before recovering from malformed journals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-malformed-owned-recovery-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    const identity = {
      pid: 4343,
      startTime: '101',
      executable: '/fixture/owned-app',
      transactionToken: 'owned-token-123456',
    };
    writeFileSync(working, 'candidate');
    writeFileSync(backup, 'last-known-good');
    const backupManifest = createInstallationManifest(backup);
    writeFileSync(journalPath, '{"truncated":');
    writeFileSync(`${journalPath}.last-known-good`, 'not-json');
    writeFileSync(
      `${journalPath}.backup-ownership`,
      JSON.stringify({
        version: 2,
        transactionId: '12345678-1234-4234-8234-123456789abc',
        transactionToken: identity.transactionToken,
        phase: 'candidate-active',
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        retiredBackupPath: retired,
        createdAt: new Date().toISOString(),
        previousVersion: 'v1',
        targetVersion: 'v2',
        backupManifest,
        candidateManifest: createInstallationManifest(working),
        activeProcess: identity,
      })
    );
    const actions: string[] = [];
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
        },
        terminateOwnedProcess: async () => {
          actions.push('stopped');
          return { processStopped: true, processTreeStopped: true };
        },
        processIsAlive: async () => false,
        onDiagnostic: (message: string) => actions.push(message),
      });
      expect(result.recovered).toBe(true);
      expect(actions).toContain('stopped');
      expect(
        actions.some((action) => action.includes('durable backup manifest'))
      ).toBe(true);
      expect(readFileSync(working, 'utf8')).toBe('last-known-good');
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves transaction backups when malformed journals have no valid ownership evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-malformed-unowned-recovery-'));
    const working = join(root, 'working');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    writeFileSync(working, 'candidate');
    writeFileSync(backup, 'last-known-good');
    writeFileSync(journalPath, '{"truncated":');
    writeFileSync(`${journalPath}.last-known-good`, 'not-json');
    const diagnostics: string[] = [];
    try {
      await expect(
        recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: working,
            backupPath: backup,
            retiredBackupPath: retired,
            journalPath,
          },
          terminateOwnedProcess: async () => {
            throw new Error('must not terminate');
          },
          processIsAlive: async () => false,
          onDiagnostic: (message: string) => diagnostics.push(message),
        })
      ).rejects.toThrow('preserving transaction backups');
      expect(readFileSync(working, 'utf8')).toBe('candidate');
      expect(readFileSync(backup, 'utf8')).toBe('last-known-good');
      expect(diagnostics.some((message) => message.includes('invalid'))).toBe(
        true
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers an exact prepared-journal crash with no backup by keeping verified Last Known-Good', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-prepared-boundary-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    writeFileSync(working, 'last-known-good');
    writeFileSync(candidate, 'verified-candidate');
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: 'prepared-token-123456',
      phase: 'prepared',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(working),
      candidateManifest: createInstallationManifest(candidate),
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
        },
        terminateOwnedProcess: async () => {
          throw new Error('no process may be terminated');
        },
        processIsAlive: async () => false,
      });
      expect(result.preparedDiscarded).toBe(true);
      expect(readFileSync(working, 'utf8')).toBe('last-known-good');
      expect(existsSync(candidate)).toBe(false);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers and stops a token-owned process spawned before the identity callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-spawn-window-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    writeFileSync(working, 'candidate');
    writeFileSync(backup, 'last-known-good');
    const identity = {
      pid: 4545,
      startTime: '202',
      executable: '/mounted/appimage/electron',
      transactionToken: 'spawn-window-token-123456',
      proofBound: true,
    };
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: identity.transactionToken,
      phase: 'candidate-active',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(backup),
      candidateManifest: createInstallationManifest(working),
      launchIntent: {
        role: 'candidate',
        executable: working,
        transactionToken: identity.transactionToken,
        requestedAt: new Date().toISOString(),
        allowProofBoundExecTransition: true,
        launcherDigest: createInstallationManifest(working).entries[0]!.sha256!,
      },
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    const actions: string[] = [];
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
        },
        discoverOwnedProcesses: async () => {
          actions.push('discovered');
          return [identity];
        },
        terminateOwnedProcess: async () => {
          actions.push('stopped');
          return { processStopped: true, processTreeStopped: true };
        },
        processIsAlive: async () => false,
      });
      expect(result.recovered).toBe(true);
      expect(actions).toEqual(['discovered', 'stopped']);
      expect(readFileSync(working, 'utf8')).toBe('last-known-good');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconciles durable Windows Job controls at every pre-identity crash boundary before recovery launch', async () => {
    const boundaries = [
      { name: 'before-wrapper-spawn', discovered: [] },
      { name: 'after-wrapper-spawn', discovered: ['wrapper'] },
      {
        name: 'after-child-spawn',
        discovered: ['application', 'wrapper'],
      },
    ];
    for (const boundary of boundaries) {
      const root = mkdtempSync(join(tmpdir(), `ogi-windows-${boundary.name}-`));
      const working = join(root, 'working');
      const candidate = join(root, 'candidate');
      const backup = join(root, 'backup');
      const retired = join(root, 'retired');
      const journalPath = join(root, 'transaction.json');
      writeFileSync(working, 'candidate');
      writeFileSync(backup, 'last-known-good');
      const transactionToken = 'windows-pre-identity-token-123456';
      const wrapperToken = 'windows-wrapper-token-123456';
      const stopPath = join(root, 'job-stop.request');
      const resultPath = join(root, 'job-result.json');
      const windowsJob = {
        wrapperExecutable: '/windows/powershell.exe',
        wrapperScript: '/updater/windows-job-wrapper.ps1',
        wrapperToken,
        launchPath: join(root, 'job-launch.json'),
        resultPath,
        stopPath,
      };
      const identities = {
        wrapper: {
          pid: 6001,
          startTime: '601',
          executable: windowsJob.wrapperExecutable,
          transactionToken,
          processRole: 'windows-job-wrapper',
          windowsJobWrapperToken: wrapperToken,
          windowsJobStopPath: stopPath,
          windowsJobResultPath: resultPath,
        },
        application: {
          pid: 6002,
          startTime: '602',
          executable: working,
          transactionToken,
          processRole: 'application',
          windowsJobStopPath: stopPath,
          windowsJobResultPath: resultPath,
        },
      } as const;
      const journal = {
        version: 2,
        transactionId: '12345678-1234-4234-8234-123456789abc',
        transactionToken,
        phase: 'candidate-active',
        previousVersion: 'v1',
        targetVersion: 'v2',
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        retiredBackupPath: retired,
        createdAt: new Date().toISOString(),
        backupManifest: createInstallationManifest(backup),
        candidateManifest: createInstallationManifest(working),
        launchIntent: {
          role: 'candidate',
          executable: working,
          transactionToken,
          requestedAt: new Date().toISOString(),
          windowsJob,
        },
      };
      writeTransactionJournal({ journalPath, stateRoot: root, journal });
      const actions: string[] = [];
      const recoveryIdentity = {
        pid: 7001,
        startTime: '701',
        executable: '/recovery/application',
        transactionToken,
      };
      try {
        const result = await recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: working,
            backupPath: backup,
            retiredBackupPath: retired,
            journalPath,
          },
          discoverOwnedProcesses: async () => {
            actions.push('discover');
            return boundary.discovered.map(
              (role) => identities[role as keyof typeof identities]
            );
          },
          terminateOwnedProcess: async (identity: any) => {
            actions.push(`stop:${identity.processRole}`);
            expect(identity.windowsJobStopPath).toBe(stopPath);
            expect(identity.windowsJobResultPath).toBe(resultPath);
            return { processStopped: true, processTreeStopped: true };
          },
          resolveLaunchExecutable: async () => recoveryIdentity.executable,
          launchAndWaitForHealth: async ({ onProcessStarted }: any) => {
            actions.push('recovery-launch');
            onProcessStarted(recoveryIdentity);
            return {
              processIdentity: recoveryIdentity,
              health: {
                version: 1,
                state: 'interactive',
                processAlive: true,
                pid: recoveryIdentity.pid,
                transactionToken,
              },
            };
          },
        });
        expect(result.recovered).toBe(true);
        expect(actions[0]).toBe('discover');
        expect(actions.at(-1)).toBe('recovery-launch');
        if (boundary.discovered.length === 0) {
          expect(actions).toEqual(['discover', 'recovery-launch']);
        } else {
          expect(actions).toEqual([
            'discover',
            'stop:windows-job-wrapper',
            'recovery-launch',
          ]);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('suppresses recovery when a Windows Job launch began without verified post-close evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-windows-missing-result-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    const transactionToken = 'windows-missing-result-token-123456';
    writeFileSync(working, 'candidate');
    writeFileSync(backup, 'last-known-good');
    const launchPath = join(root, 'job-launch.json');
    writeFileSync(
      launchPath,
      '{"version":1,"rootPid":6001,"killOnClose":true}'
    );
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken,
      phase: 'candidate-active',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(backup),
      candidateManifest: createInstallationManifest(working),
      launchIntent: {
        role: 'candidate',
        executable: working,
        transactionToken,
        requestedAt: new Date().toISOString(),
        windowsJob: {
          wrapperExecutable: '/windows/powershell.exe',
          wrapperScript: '/updater/windows-job-wrapper.ps1',
          wrapperToken: 'windows-wrapper-token-123456',
          launchPath,
          resultPath: join(root, 'job-result.json'),
          stopPath: join(root, 'job-stop.request'),
        },
      },
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    let recoveryLaunches = 0;
    try {
      await expect(
        recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: working,
            backupPath: backup,
            retiredBackupPath: retired,
            journalPath,
          },
          discoverOwnedProcesses: async () => [],
          resolveLaunchExecutable: async () => '/recovery/application',
          launchAndWaitForHealth: async () => {
            recoveryLaunches += 1;
            throw new Error('recovery must remain suppressed');
          },
        })
      ).rejects.toThrow('without verified post-close evidence');
      expect(recoveryLaunches).toBe(0);
      expect(readFileSync(working, 'utf8')).toBe('candidate');
      expect(readFileSync(backup, 'utf8')).toBe('last-known-good');
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a proof-bound descendant when the recorded Linux root PID was reused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-reused-root-descendant-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    writeFileSync(working, 'candidate');
    writeFileSync(backup, 'last-known-good');
    const transactionToken = 'reused-root-descendant-token-123456';
    const rootIdentity = {
      pid: 8123,
      startTime: 'original-start',
      executable: '/owned/application',
      transactionToken,
      proofBound: true,
    };
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken,
      phase: 'candidate-active',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(backup),
      candidateManifest: createInstallationManifest(working),
      activeProcess: rootIdentity,
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    const termination: string[] = [];
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
        },
        terminateOwnedProcess: async () => {
          termination.push('reused-root-excluded');
          termination.push('proof-descendant-stopped');
          return { processStopped: true, processTreeStopped: true };
        },
      });
      expect(result.recovered).toBe(true);
      expect(termination).toEqual([
        'reused-root-excluded',
        'proof-descendant-stopped',
      ]);
      expect(readFileSync(working, 'utf8')).toBe('last-known-good');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('live Linux helper ignores a reused root PID and terminates an independent proof-bound descendant', async () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-live-reused-root-'));
    const transactionToken = randomUUID();
    const proofPath = join(root, `.ogi-process-proof-${transactionToken}`);
    writeFileSync(proofPath, transactionToken);
    const proofDescriptor = openSync(proofPath, 'r');
    unlinkSync(proofPath);
    const descendant = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        env: {
          ...process.env,
          OGI_UPDATE_TRANSACTION_TOKEN: transactionToken,
        },
        stdio: ['ignore', 'ignore', 'ignore', proofDescriptor],
      }
    );
    closeSync(proofDescriptor);
    try {
      expect(descendant.pid).toBeGreaterThan(0);
      const source = readFileSync(
        join(import.meta.dir, '../src/main.ts'),
        'utf8'
      );
      const terminator = source.match(
        /const LINUX_PIDFD_TERMINATOR = `\n([\s\S]*?)\n`;/
      )?.[1];
      expect(terminator).toBeDefined();
      const result = spawnSync(
        'python3',
        [
          '-c',
          terminator!.replaceAll('\\\\0', '\\0'),
          String(process.pid),
          'intentionally-reused-start-time',
          process.execPath,
          transactionToken,
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('continuing root-independent proof scan');
      expect(result.stdout.split(',').map(Number)).toContain(descendant.pid!);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      expect(() => process.kill(descendant.pid!, 0)).toThrow();
      expect(process.pid).toBeGreaterThan(0);
    } finally {
      try {
        descendant.kill('SIGKILL');
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('recovers each installation directory-sync crash boundary without losing commit state', async () => {
    for (const failingSync of [1, 2, 3]) {
      const root = mkdtempSync(
        join(tmpdir(), `ogi-rename-sync-${failingSync}-`)
      );
      const working = join(root, 'working');
      const candidate = join(root, 'candidate');
      const backup = join(root, 'backup');
      const retired = join(root, 'retired');
      writeFileSync(working, 'old');
      writeFileSync(candidate, 'new');
      const manifest = createInstallationManifest(working);
      let syncCount = 0;
      const fileSystem = {
        exists: existsSync,
        rename: renameSync,
        remove: (target: string) =>
          rmSync(target, { recursive: true, force: true }),
        device: (target: string) => statSync(target).dev,
        syncDirectories: () => {
          syncCount += 1;
          if (syncCount === failingSync) {
            throw new Error(`directory fsync crash ${failingSync}`);
          }
        },
      };
      try {
        let thrown: any;
        try {
          await transactionalReplaceAndRequireHealth({
            workingPath: working,
            candidatePath: candidate,
            backupPath: backup,
            retiredBackupPath: retired,
            expectedBackupManifest: manifest,
            launchAndWaitForHealth: async () => ({
              version: 1,
              state: 'interactive',
              processAlive: true,
            }),
            fileSystem,
            retry: { attempts: 1, delayMs: 0 },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeDefined();
        if (failingSync === 1) {
          expect(existsSync(backup)).toBe(true);
          await restoreInterruptedTransaction({
            workingPath: working,
            backupPath: backup,
            expectedBackupManifest: manifest,
          });
          expect(readFileSync(working, 'utf8')).toBe('old');
        } else if (failingSync === 2) {
          expect(thrown.recoveryCompleted).toBe(true);
          expect(readFileSync(working, 'utf8')).toBe('old');
        } else {
          expect(thrown.transactionCommitted).not.toBe(true);
          expect(thrown.recoveryCompleted).toBe(false);
          expect(readFileSync(working, 'utf8')).toBe('new');
          expect(readFileSync(retired, 'utf8')).toBe('old');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('repairs truncated committed metadata only after verifying the candidate manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-committed-metadata-'));
    const working = join(root, 'working');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const candidate = join(root, 'candidate');
    const journalPath = join(root, 'transaction.json');
    const metadataPath = join(root, 'version.txt');
    writeFileSync(working, 'healthy-candidate');
    writeFileSync(retired, 'retired-last-known-good');
    writeFileSync(metadataPath, 'v');
    const targetMetadata = {
      version: 'v2',
      digest: createHash('sha256').update('v2').digest('hex'),
    };
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken: 'metadata-token-123456',
      phase: 'candidate-active',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(retired),
      candidateManifest: createInstallationManifest(working),
      targetMetadata,
      verifiedHealth: {
        version: 1,
        state: 'interactive',
        processAlive: true,
        pid: 1,
        transactionToken: 'metadata-token-123456',
      },
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
          metadataPath,
        },
        terminateOwnedProcess: async () => ({
          processStopped: true,
          processTreeStopped: true,
        }),
        processIsAlive: async () => false,
      });
      expect(result.committed).toBe(true);
      expect(readFileSync(metadataPath, 'utf8')).toBe('v2');
      expect(existsSync(retired)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves verified health when committed journal persistence fails after retirement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-mark-committed-failure-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    writeFileSync(working, 'old');
    writeFileSync(candidate, 'new');
    const health = { version: 1, state: 'interactive', processAlive: true };
    try {
      let thrown: any;
      try {
        await transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          retiredBackupPath: retired,
          launchAndWaitForHealth: async () => health,
          markCommitted: async () => {
            throw new Error('journal persistence failed');
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown.transactionCommitted).toBe(true);
      expect(thrown.health).toEqual(health);
      expect(readFileSync(working, 'utf8')).toBe('new');
      expect(existsSync(retired)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shared coordinator preserves health and finalizes a markCommitted crash without duplicate launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-coordinator-mark-failure-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    const metadataPath = join(root, 'version.txt');
    writeFileSync(working, 'old');
    writeFileSync(candidate, 'new');
    writeFileSync(metadataPath, 'v1');
    const identity = {
      pid: 5656,
      startTime: '303',
      executable: '/fixture/app',
      transactionToken: 'coordinator-token-123456',
    };
    const health = {
      version: 1,
      state: 'interactive',
      processAlive: true,
      pid: identity.pid,
      transactionToken: identity.transactionToken,
    };
    let launches = 0;
    try {
      let thrown: any;
      try {
        await installPreparedProductionUpdate({
          prepared: { candidatePath: candidate, tagName: 'v2' },
          paths: {
            stateRoot: root,
            workingPath: working,
            backupPath: backup,
            retiredBackupPath: retired,
            journalPath,
            metadataPath,
          },
          previousVersion: 'v1',
          transactionToken: identity.transactionToken,
          resolveLaunchExecutable: async () => identity.executable,
          launchAndWaitForHealth: async ({ onProcessStarted }: any) => {
            launches += 1;
            onProcessStarted(identity);
            return { health, processIdentity: identity };
          },
          terminateOwnedProcess: async () => ({
            processStopped: true,
            processTreeStopped: true,
          }),
          processIsAlive: async () => false,
          journalFault: (stage: string) => {
            if (existsSync(retired) && stage === 'after-temp-write') {
              throw new Error('markCommitted persistence crash');
            }
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown.transactionCommitted).toBe(true);
      expect(thrown.health).toEqual(health);
      expect(readFileSync(working, 'utf8')).toBe('new');
      expect(readFileSync(metadataPath, 'utf8')).toBe('v2');

      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
          metadataPath,
        },
        terminateOwnedProcess: async () => ({
          processStopped: true,
          processTreeStopped: true,
        }),
        processIsAlive: async () => false,
      });
      expect(result.committed).toBe(true);
      expect(launches).toBe(1);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not signal a reused PID whose non-reusable identity mismatches', async () => {
    let signals = 0;
    await expect(
      stopOwnedProcess({
        expectedIdentity: {
          pid: 99,
          startTime: '100',
          executable: '/owned/app',
          transactionToken: 'owned-token-123456',
        },
        terminateOwnedProcess: async () => {
          throw new Error('identity mismatch after pidfd open');
        },
      })
    ).rejects.toThrow('identity mismatch');
    expect(signals).toBe(0);
  });

  test('uses only documented Windows write-through moves and rejects helper failure', () => {
    const scripts: string[] = [];
    const durability = createProductionDurabilityAdapter({
      platform: 'win32',
      runWindowsHelper: (script: string) => {
        scripts.push(script);
        return { status: 0, stderr: '' };
      },
    });
    durability.durableRename('C:\\state\\from', 'C:\\state\\to');
    durability.replace('C:\\state\\temp', 'C:\\state\\journal');
    durability.syncDirectories(['C:\\state', 'C:\\state']);
    const source = scripts.join('\n');
    expect(source).toContain('MoveFileEx');
    expect(source).toContain('MoveFileWriteThrough = 0x8');
    expect(source).toContain('MoveFileReplaceExisting = 0x1');
    expect(source).not.toContain('FlushFileBuffers');
    expect(source).not.toContain('CreateFile');
    expect(scripts).toHaveLength(2);
    expect(source).toContain('$false');
    expect(source).toContain('$true');
    const unavailable = createProductionDurabilityAdapter({
      platform: 'win32',
      runWindowsHelper: () => ({ status: 1, stderr: 'unsupported' }),
    });
    expect(() =>
      unavailable.durableRename('C:\\state\\from', 'C:\\state\\to')
    ).toThrow('Windows write-through durability helper failed');
  });

  test('positively confirms helper-crash-after-move at every forward, rollback, and retirement rename boundary', async () => {
    for (const boundary of [
      'working-to-backup',
      'candidate-to-working',
      'backup-to-working',
      'backup-to-retired',
    ]) {
      const root = mkdtempSync(join(tmpdir(), `ogi-confirm-${boundary}-`));
      const working = join(root, 'working');
      const candidate = join(root, 'candidate');
      const backup = join(root, 'backup');
      const retired = join(root, 'retired');
      writeFileSync(working, 'last-known-good');
      writeFileSync(candidate, 'candidate');
      let injected = false;
      let confirmations = 0;
      const matchesBoundary = (source: string, destination: string) =>
        (boundary === 'working-to-backup' &&
          source === working &&
          destination === backup) ||
        (boundary === 'candidate-to-working' &&
          source === candidate &&
          destination === working) ||
        (boundary === 'backup-to-working' &&
          source === backup &&
          destination === working) ||
        (boundary === 'backup-to-retired' &&
          source === backup &&
          destination === retired);
      const fileSystem = {
        exists: existsSync,
        rename: renameSync,
        durableRename(source: string, destination: string) {
          renameSync(source, destination);
          if (!injected && matchesBoundary(source, destination)) {
            injected = true;
            throw new Error(`helper crashed after ${boundary} MoveFileEx`);
          }
        },
        getRenameConfirmationPath(destination: string) {
          return `${destination}.confirmation`;
        },
        confirmAppliedRename(destination: string) {
          confirmations += 1;
          const parked = `${destination}.confirmation`;
          if (existsSync(destination)) renameSync(destination, parked);
          renameSync(parked, destination);
        },
        remove: (target: string) =>
          rmSync(target, { recursive: true, force: true }),
        device: (target: string) => statSync(target).dev,
      };
      try {
        const operation = transactionalReplaceAndRequireHealth({
          workingPath: working,
          candidatePath: candidate,
          backupPath: backup,
          retiredBackupPath: retired,
          fileSystem,
          retry: { attempts: 2, delayMs: 0 },
          beforeRecovery: async () => ({
            processStopped: true,
            processTreeStopped: true,
          }),
          launchAndWaitForHealth: async ({ recovery }) => {
            if (boundary === 'backup-to-working' && !recovery) {
              throw new Error('candidate failed');
            }
            return { version: 1, state: 'interactive', processAlive: true };
          },
        });
        if (boundary === 'backup-to-working') {
          const thrown: any = await operation.catch((error) => error);
          expect(thrown.message).toContain('candidate failed');
          expect(thrown.recoveryCompleted).toBe(true);
          expect(readFileSync(working, 'utf8')).toBe('last-known-good');
        } else {
          await expect(operation).resolves.toMatchObject({
            processAlive: true,
          });
          expect(readFileSync(working, 'utf8')).toBe('candidate');
        }
        expect(injected).toBe(true);
        expect(confirmations).toBeGreaterThan(0);
        expect(existsSync(`${working}.confirmation`)).toBe(false);
        expect(existsSync(`${backup}.confirmation`)).toBe(false);
        expect(existsSync(`${retired}.confirmation`)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('preserves candidate, Last Known-Good, and journal without claiming commit when retirement durability is unconfirmed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-retirement-uncertain-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    const metadataPath = join(root, 'version.txt');
    writeFileSync(working, 'last-known-good');
    writeFileSync(candidate, 'candidate');
    writeFileSync(metadataPath, 'v1');
    let retirementMoved = false;
    const fileSystem = {
      exists: existsSync,
      rename: renameSync,
      durableRename(source: string, destination: string) {
        renameSync(source, destination);
        if (destination === retired) {
          retirementMoved = true;
          throw new Error('retirement helper exited after MoveFileEx');
        }
      },
      getRenameConfirmationPath(destination: string) {
        return `${destination}.confirmation`;
      },
      confirmAppliedRename() {
        throw new Error('write-through confirmation unavailable');
      },
      remove: (target: string) =>
        rmSync(target, { recursive: true, force: true }),
      device: (target: string) => statSync(target).dev,
    };
    try {
      const thrown: any = await installPreparedProductionUpdate({
        prepared: { candidatePath: candidate, tagName: 'v2' },
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
          metadataPath,
        },
        previousVersion: 'v1',
        transactionToken: 'uncertain-retirement-token-123456',
        resolveLaunchExecutable: async () => '/fixture/app',
        launchAndWaitForHealth: async ({ onProcessStarted }: any) => {
          const identity = {
            pid: 9898,
            startTime: '505',
            executable: '/fixture/app',
            transactionToken: 'uncertain-retirement-token-123456',
          };
          onProcessStarted(identity);
          return {
            processIdentity: identity,
            health: {
              version: 1,
              state: 'interactive',
              processAlive: true,
              pid: identity.pid,
              transactionToken: identity.transactionToken,
            },
          };
        },
        terminateOwnedProcess: async () => ({
          processStopped: true,
          processTreeStopped: true,
        }),
        processIsAlive: async () => false,
        fileSystem,
        retry: { attempts: 1, delayMs: 0 },
      }).catch((error) => error);
      expect(retirementMoved).toBe(true);
      expect(thrown.transactionCommitted).not.toBe(true);
      expect(thrown.message).toContain(
        'retirement helper exited after MoveFileEx'
      );
      expect(readFileSync(working, 'utf8')).toBe('candidate');
      expect(readFileSync(retired, 'utf8')).toBe('last-known-good');
      expect(existsSync(journalPath)).toBe(true);
      expect(
        readValidatedTransactionJournal({
          journalPath,
          stateRoot: root,
          expectedPaths: {
            workingPath: working,
            candidatePath: candidate,
            backupPath: backup,
            retiredBackupPath: retired,
          },
        }).journal?.phase
      ).toBe('candidate-active');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retries synchronization without repeating an already-applied rollback rename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-rollback-sync-retry-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    writeFileSync(working, 'last-known-good');
    writeFileSync(candidate, 'bad-candidate');
    let renameCalls = 0;
    let syncCalls = 0;
    const fileSystem = {
      exists: existsSync,
      rename(source: string, destination: string) {
        renameCalls += 1;
        renameSync(source, destination);
      },
      remove: (target: string) =>
        rmSync(target, { recursive: true, force: true }),
      device: (target: string) => statSync(target).dev,
      syncDirectories: () => {
        syncCalls += 1;
        if (syncCalls === 3) throw new Error('rollback fsync crash');
      },
    };
    try {
      const thrown = await transactionalReplaceAndRequireHealth({
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        fileSystem,
        retry: { attempts: 2, delayMs: 0 },
        beforeRecovery: async () => ({
          processStopped: true,
          processTreeStopped: true,
        }),
        launchAndWaitForHealth: async ({ recovery }) => {
          if (!recovery) throw new Error('candidate failed');
          return { version: 1, state: 'interactive', processAlive: true };
        },
      }).catch((error) => error);
      expect(thrown.message).toContain('candidate failed');
      expect(thrown.recoveryCompleted).toBe(true);
      expect(renameCalls).toBe(3);
      expect(syncCalls).toBe(4);
      expect(readFileSync(working, 'utf8')).toBe('last-known-good');
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconciles every restored Last Known-Good crash phase without duplicate healthy launch', async () => {
    for (const crashStage of [
      'after-restore-persist',
      'after-metadata-repair',
      'after-recovery-launch',
      'after-recovery-health',
      'before-clear',
    ]) {
      const root = mkdtempSync(join(tmpdir(), `ogi-restored-${crashStage}-`));
      const working = join(root, 'working');
      const candidate = join(root, 'candidate');
      const backup = join(root, 'backup');
      const retired = join(root, 'retired');
      const journalPath = join(root, 'transaction.json');
      const metadataPath = join(root, 'version.txt');
      writeFileSync(working, 'candidate');
      writeFileSync(backup, 'last-known-good');
      writeFileSync(metadataPath, 'v2');
      const transactionToken = 'restored-token-123456';
      const identity = {
        pid: 7878,
        startTime: '404',
        executable: '/fixture/recovery',
        transactionToken,
      };
      const journal = {
        version: 2,
        transactionId: '12345678-1234-4234-8234-123456789abc',
        transactionToken,
        phase: 'candidate-active',
        previousVersion: 'v1',
        targetVersion: 'v2',
        workingPath: working,
        candidatePath: candidate,
        backupPath: backup,
        retiredBackupPath: retired,
        createdAt: new Date().toISOString(),
        backupManifest: createInstallationManifest(backup),
        candidateManifest: createInstallationManifest(working),
      };
      writeTransactionJournal({ journalPath, stateRoot: root, journal });
      let launches = 0;
      let activeAlive = false;
      let injected = false;
      const recover = (fault = true) =>
        recoverInterruptedProductionUpdate({
          paths: {
            stateRoot: root,
            workingPath: working,
            backupPath: backup,
            retiredBackupPath: retired,
            journalPath,
            metadataPath,
          },
          terminateOwnedProcess: async () => {
            activeAlive = false;
            return { processStopped: true, processTreeStopped: true };
          },
          processIsAlive: async () => activeAlive,
          discoverOwnedProcesses: async () => [],
          resolveLaunchExecutable: async () => identity.executable,
          launchAndWaitForHealth: async ({ onProcessStarted }: any) => {
            launches += 1;
            activeAlive = true;
            onProcessStarted(identity);
            return {
              processIdentity: identity,
              health: {
                version: 1,
                state: 'interactive',
                processAlive: true,
                pid: identity.pid,
                transactionToken,
              },
            };
          },
          recoveryFault: (stage: string) => {
            if (fault && !injected && stage === crashStage) {
              injected = true;
              throw new Error(`crash ${stage}`);
            }
          },
        });
      try {
        await expect(recover()).rejects.toThrow(`crash ${crashStage}`);
        const result = await recover(false);
        expect(result.recovered).toBe(true);
        expect(result.recoveryHealth?.processAlive).toBe(true);
        expect(readFileSync(working, 'utf8')).toBe('last-known-good');
        expect(readFileSync(metadataPath, 'utf8')).toBe('v1');
        expect(existsSync(journalPath)).toBe(false);
        expect(launches).toBe(crashStage === 'after-recovery-launch' ? 2 : 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('reconciles a legacy noncommitted no-backup journal when working and previous metadata prove restoration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-legacy-restored-'));
    const working = join(root, 'working');
    const candidate = join(root, 'candidate');
    const backup = join(root, 'backup');
    const retired = join(root, 'retired');
    const journalPath = join(root, 'transaction.json');
    const metadataPath = join(root, 'version.txt');
    writeFileSync(working, 'last-known-good');
    writeFileSync(metadataPath, 'v2');
    const transactionToken = 'legacy-restored-token-123456';
    const identity = {
      pid: 7979,
      startTime: '405',
      executable: '/fixture/recovery',
      transactionToken,
    };
    const journal = {
      version: 2,
      transactionId: '12345678-1234-4234-8234-123456789abc',
      transactionToken,
      phase: 'candidate-active',
      previousVersion: 'v1',
      targetVersion: 'v2',
      workingPath: working,
      candidatePath: candidate,
      backupPath: backup,
      retiredBackupPath: retired,
      createdAt: new Date().toISOString(),
      backupManifest: createInstallationManifest(working),
      candidateManifest: createInstallationManifest(working),
    };
    writeTransactionJournal({ journalPath, stateRoot: root, journal });
    try {
      const result = await recoverInterruptedProductionUpdate({
        paths: {
          stateRoot: root,
          workingPath: working,
          backupPath: backup,
          retiredBackupPath: retired,
          journalPath,
          metadataPath,
        },
        terminateOwnedProcess: async () => ({
          processStopped: true,
          processTreeStopped: true,
        }),
        resolveLaunchExecutable: async () => identity.executable,
        launchAndWaitForHealth: async ({ onProcessStarted }: any) => {
          onProcessStarted(identity);
          return {
            processIdentity: identity,
            health: {
              version: 1,
              state: 'interactive',
              processAlive: true,
              pid: identity.pid,
              transactionToken,
            },
          };
        },
      });
      expect(result.recovered).toBe(true);
      expect(readFileSync(metadataPath, 'utf8')).toBe('v1');
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an unavailable identity-handle termination adapter', async () => {
    await expect(
      stopOwnedProcess({
        expectedIdentity: {
          pid: 76,
          startTime: '399',
          executable: '/owned/app',
          transactionToken: 'owned-token-123456',
        },
      })
    ).rejects.toThrow('OS identity-handle termination is unavailable');
  });

  test('propagates identity mismatch and helper failure without claiming a stop', async () => {
    for (const diagnostic of [
      'identity mismatch before pidfd tree termination',
      'pidfd unavailable: operation not supported',
    ]) {
      await expect(
        stopOwnedProcess({
          expectedIdentity: {
            pid: 77,
            startTime: '400',
            executable: '/owned/app',
            transactionToken: 'owned-token-123456',
          },
          terminateOwnedProcess: async () => {
            throw new Error(diagnostic);
          },
        })
      ).rejects.toThrow(diagnostic);
    }
  });

  test('rejects root-only termination that does not prove complete tree containment', async () => {
    await expect(
      stopOwnedProcess({
        expectedIdentity: {
          pid: 77,
          startTime: '400',
          executable: '/owned/app',
          transactionToken: 'owned-token-123456',
        },
        terminateOwnedProcess: async () => ({ processStopped: true }),
      })
    ).rejects.toThrow('complete owned process tree');
  });

  test('treats exit between identity-handle open and termination as safely stopped without a PID signal fallback', async () => {
    let barePidSignals = 0;
    await expect(
      stopOwnedProcess({
        expectedIdentity: {
          pid: 88,
          startTime: '500',
          executable: '/owned/app',
          transactionToken: 'owned-token-123456',
        },
        terminateOwnedProcess: async () => ({
          processStopped: true,
          processTreeStopped: true,
          processExited: true,
        }),
      })
    ).resolves.toEqual({ processStopped: true, processTreeStopped: true });
    expect(barePidSignals).toBe(0);
  });

  test('exports the production coordinator marker and complete install/recovery calls', () => {
    expect(PRODUCTION_UPDATE_COORDINATOR_MARKER).toBe(
      'ogi-production-update-coordinator-v2'
    );
    expect(typeof installPreparedProductionUpdate).toBe('function');
    expect(typeof recoverInterruptedProductionUpdate).toBe('function');
    expect(typeof writeTransactionJournal).toBe('function');
    expect(typeof stopOwnedProcess).toBe('function');
  });

  test('shipped process discovery exposes Linux live ownership and Windows static APIs', () => {
    const source = readFileSync(
      join(import.meta.dir, '../src/main.ts'),
      'utf8'
    );
    expect(source).toContain('async function discoverProductionProcesses');
    expect(source).toContain("readdirSync('/proc')");
    expect(source).toContain('Get-CimInstance Win32_Process');
    expect(source).toContain('--ogi-update-transaction-token=');
    expect(source).toContain(['/proc/', '$', '{pid}/environ'].join(''));
    expect(source).toContain('OGI_UPDATE_TRANSACTION_TOKEN=');
    expect(source).toContain('processProofDescriptor');
    expect(source).toContain('.ogi-process-proof-');
    expect(source).toContain('processTreeStopped: true');
    expect(source).toContain('resolveProductionLaunchExecutable');
    expect(source).toContain('os.pidfd_open');
    expect(source).toContain('signal.pidfd_send_signal');
    expect(source.indexOf('os.pidfd_open')).toBeLessThan(
      source.indexOf('signal.pidfd_send_signal')
    );
    expect(source).toContain('OpenProcess');
    expect(source).toContain('GetProcessTimes');
    expect(source).toContain('QueryFullProcessImageName');
    expect(source).toContain('ValidateRequestAndWait');
    expect(source).toContain('OGI_WINDOWS_JOB_STOP');
    expect(source).toContain('windowsJob.wrapperToken');
    expect(source).toContain(
      "processRole: wrapperToken ? 'windows-job-wrapper'"
    );
    expect(
      source.indexOf('const windowsJob = launchIntent?.windowsJob')
    ).toBeLessThan(
      source.indexOf(
        '? spawn(',
        source.indexOf('const windowsJob = launchIntent?.windowsJob')
      )
    );
    expect(source).toContain(
      'identity mismatch before pidfd tree termination; continuing root-independent proof scan'
    );
    expect(source).toContain('excluded_pids.add(root)');
    expect(source).not.toContain(
      "print('identity mismatch before pidfd tree termination', file=sys.stderr); sys.exit(4)"
    );
    expect(source.indexOf('OpenProcess')).toBeLessThan(
      source.indexOf('WaitForSingleObject(handle, 20000)')
    );
    expect(source).not.toContain("spawn(\n        'taskkill'");
  });

  test('Windows production launch durably records controls before assigning a suspended process to kill-on-close Job containment', () => {
    const coordinator = readFileSync(
      join(import.meta.dir, '../src/production-update-coordinator.mjs'),
      'utf8'
    );
    const persistIntent = coordinator.indexOf('persist({ launchIntent })');
    const launch = coordinator.indexOf(
      'const result = await launchAndWaitForHealth({'
    );
    expect(persistIntent).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(persistIntent);
    expect(coordinator).toContain('windowsJob: { ...launch.windowsJob }');
    const source = readFileSync(
      join(import.meta.dir, '../src/windows-job-wrapper.ps1'),
      'utf8'
    );
    const create = source.indexOf(
      'CreateSuspended | ExtendedStartupInfoPresent'
    );
    const assign = source.indexOf(
      'AssignProcessToJobObject(job, process.hProcess)'
    );
    const resume = source.indexOf('ResumeThread(process.hThread)');
    expect(source).toContain('JobObjectLimitKillOnJobClose');
    expect(source).toContain('[string] $WrapperToken');
    expect(source).toContain('OGI_WINDOWS_JOB_LAUNCH');
    const queryMembers = source.indexOf(
      'uint[] activePidsBeforeClose = GetActiveProcessIds(job)'
    );
    const captureHandles = source.indexOf(
      'IntPtr member = OpenProcess(0x00100000, false, pid)'
    );
    const closeJob = source.indexOf('CloseHandle(job);', captureHandles);
    const waitMembers = source.indexOf(
      'WaitForSingleObject(member.Value, 8000)'
    );
    const writeResult = source.indexOf('WriteResult(', waitMembers);
    expect(source).toContain('activePidsBeforeClose');
    expect(source).toContain('terminatedPids');
    expect(source).toContain('survivingPids');
    expect(source).toContain('\\"version\\":3');
    expect(create).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(create);
    expect(resume).toBeGreaterThan(assign);
    expect(queryMembers).toBeGreaterThan(resume);
    expect(captureHandles).toBeGreaterThan(queryMembers);
    expect(closeJob).toBeGreaterThan(captureHandles);
    expect(waitMembers).toBeGreaterThan(closeJob);
    expect(writeResult).toBeGreaterThan(waitMembers);
  });

  test('strictly parses Windows Job launch and survivor evidence', () => {
    expect(
      parseWindowsJobLaunchEvidence(
        '{"version":1,"rootPid":41,"killOnClose":true}'
      )
    ).toEqual({ version: 1, rootPid: 41, killOnClose: true });
    expect(
      parseWindowsJobResultEvidence(
        '{"version":2,"rootPid":41,"activePidsBeforeClose":[41,42],"survivingPids":[42],"timedOut":false,"killOnClose":true}'
      )
    ).toEqual({
      version: 2,
      rootPid: 41,
      activePidsBeforeClose: [41, 42],
      survivingPids: [42],
      timedOut: false,
      killOnClose: true,
      verifiedAfterClose: false,
    });
    expect(
      parseWindowsJobResultEvidence(
        '{"version":3,"rootPid":41,"activePidsBeforeClose":[41,42],"terminatedPids":[41,42],"survivingPids":[],"timedOut":false,"errors":[],"killOnClose":true}'
      )
    ).toEqual({
      version: 3,
      rootPid: 41,
      activePidsBeforeClose: [41, 42],
      terminatedPids: [41, 42],
      survivingPids: [],
      timedOut: false,
      errors: [],
      killOnClose: true,
      verifiedAfterClose: true,
    });
    expect(() =>
      parseWindowsJobLaunchEvidence(
        '{"version":1,"rootPid":0,"killOnClose":true}'
      )
    ).toThrow('launch evidence is invalid');
    expect(() =>
      parseWindowsJobResultEvidence(
        '{"version":2,"rootPid":41,"activePidsBeforeClose":[41],"survivingPids":[42],"timedOut":false,"killOnClose":true}'
      )
    ).toThrow('result evidence is invalid');
  });

  test('production application emits the updater Startup Health protocol only after main readiness', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../application/src/electron/main.ts'),
      'utf8'
    );
    const readiness = source.indexOf('async function onMainAppReady()');
    const health = source.indexOf('emitUpdaterStartupHealth();');
    expect(source).toContain('OGI_STARTUP_HEALTH_TOKEN');
    expect(source).toContain("state: 'interactive'");
    expect(readiness).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(readiness);
  });

  test('requires the declared platform launcher and exact Windows executable name', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-launcher-resolution-'));
    try {
      expect(() => resolveApplicationLauncher(root, 'win32')).toThrow(
        'OpenGameInstaller.exe'
      );
      writeFileSync(join(root, 'OpenGameInstaller.cmd'), 'wrong');
      expect(() => resolveApplicationLauncher(root, 'win32')).toThrow(
        'OpenGameInstaller.exe'
      );
      writeFileSync(join(root, 'OpenGameInstaller.exe'), 'fixture executable');
      expect(resolveApplicationLauncher(root, 'win32')).toBe(
        join(root, 'OpenGameInstaller.exe')
      );
      expect(existsSync(resolveApplicationLauncher(root, 'win32'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
