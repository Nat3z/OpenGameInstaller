import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect, Schema } from 'effect';
import {
  loadLibraryInfo,
  saveLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { __dirname as ogiDirectory } from '@/electron/manager/manager.paths.js';
import { resolveInside, scanFiles, writeJsonAtomic } from './files.js';
import {
  type OwnershipManifest,
  OwnershipManifestSchema,
  type UpdateManifest,
} from './model.js';
import { captureOwnershipFiles } from './ownership.js';
import { adoptStaging, removeStaging } from './staging.js';

const updateDirectory = join(ogiDirectory, 'internals', 'update-system');
const ownershipDirectory = join(updateDirectory, 'ownership');
const transactionDirectory = join(updateDirectory, 'transactions');

const TransactionJournalSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  appID: Schema.NonNegativeInt,
  root: Schema.String,
  sourceSetKey: Schema.String,
  extractedPath: Schema.String,
  beforeFiles: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.NonNegativeInt,
      sha256: Schema.String,
    })
  ),
  backups: Schema.Array(
    Schema.Struct({
      installedPath: Schema.String,
      backupPath: Schema.String,
    })
  ),
  previousOwnership: Schema.optional(OwnershipManifestSchema),
  previousLibrary: Schema.optional(Schema.Unknown),
  expectedLibrary: Schema.optional(
    Schema.Struct({
      version: Schema.String,
      cwd: Schema.String,
      launchExecutable: Schema.String,
      launchArguments: Schema.optional(Schema.String),
      addonSource: Schema.optional(Schema.String),
    })
  ),
  state: Schema.Literal('preparing', 'prepared', 'committing'),
});

interface TransactionJournal
  extends Omit<
    typeof TransactionJournalSchema.Type,
    'previousLibrary' | 'previousOwnership'
  > {
  readonly previousOwnership?: OwnershipManifest;
  readonly previousLibrary?: LibraryInfo;
}

/** Transaction ids are randomUUID() values; anything else is rejected before path joins. */
const transactionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidTransactionId(id: string): boolean {
  return transactionIdPattern.test(id);
}

export interface ExpectedLibraryUpdate {
  readonly version: string;
  readonly cwd: string;
  readonly launchExecutable: string;
  readonly launchArguments?: string;
  readonly addonSource?: string;
}

export interface PreparedTransaction {
  readonly transactionId: string;
  readonly setupPath: string;
}

function ownershipPath(appID: number): string {
  return join(ownershipDirectory, `${appID}.json`);
}

function journalPath(id: string): string {
  return join(transactionDirectory, id, 'journal.json');
}

function fileError(path: string, cause: unknown): FileSystemError {
  return new FileSystemError({
    message: `Update transaction failed: ${String(cause)}`,
    path,
    cause,
  });
}

export function loadOwnership(
  appID: number
): Effect.Effect<OwnershipManifest | undefined> {
  const path = ownershipPath(appID);
  return Effect.tryPromise({
    try: async () => JSON.parse(await fs.readFile(path, 'utf8')) as unknown,
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknown(OwnershipManifestSchema, {
            onExcessProperty: 'error',
          })(value).pipe(
            Effect.map((manifest) => manifest as OwnershipManifest),
            Effect.catchAll(() => Effect.succeed(undefined))
          )
    )
  );
}

export function prepareTransaction(input: {
  readonly appID: number;
  readonly installationPath: string;
  readonly extractedPath: string;
  readonly manifest: UpdateManifest;
}): Effect.Effect<PreparedTransaction, FileSystemError> {
  return Effect.gen(function* () {
    const ownership = yield* loadOwnership(input.appID);
    const previousLibrary = loadLibraryInfo(input.appID);
    const before = yield* scanFiles(input.installationPath).pipe(
      Effect.tapError(() => removeStaging(input.extractedPath))
    );
    const id = randomUUID();
    const directory = join(transactionDirectory, id);
    const backups: TransactionJournal['backups'][number][] = [];
    const targetByPath = new Map(
      input.manifest.entries.map((entry) => [entry.path, entry] as const)
    );
    const filesToProtect = before.map((file) => ({
      installedPath: file.path,
      size: file.size,
    }));
    // Every protected file gets a rollback copy below, so budget for all of
    // them (reflinks may use less, but plan for the worst case).
    const requiredBackupBytes = filesToProtect.reduce(
      (total, file) => total + file.size,
      0
    );
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(directory, { recursive: true });
        const space = await fs.statfs(directory);
        const availableBytes = space.bavail * space.bsize;
        if (availableBytes < requiredBackupBytes) {
          throw new Error(
            `Update needs ${requiredBackupBytes} bytes of rollback space, but only ${availableBytes} bytes are available`
          );
        }
      },
      catch: (cause) => fileError(directory, cause),
    }).pipe(
      Effect.tapError(() => cleanupPreparation(directory, input.extractedPath))
    );
    for (const owned of filesToProtect) {
      const installed = resolveInside(
        input.installationPath,
        owned.installedPath
      );
      const exists = yield* Effect.promise(() =>
        fs.stat(installed).then(
          (stat) => stat.isFile(),
          () => false
        )
      );
      if (!exists) continue;
      const backupPath = join(directory, 'backup', owned.installedPath);
      backups.push({
        installedPath: owned.installedPath,
        backupPath,
      });
    }
    const preparing: TransactionJournal = {
      schemaVersion: 1,
      id,
      appID: input.appID,
      root: input.installationPath,
      sourceSetKey: input.manifest.sourceSetKey,
      extractedPath: input.extractedPath,
      beforeFiles: before,
      backups,
      ...(ownership ? { previousOwnership: ownership } : {}),
      ...(previousLibrary
        ? { previousLibrary: structuredClone(previousLibrary) }
        : {}),
      state: 'preparing',
    };
    yield* Effect.tryPromise({
      try: () => writeJsonAtomic(journalPath(id), preparing),
      catch: (cause) => fileError(journalPath(id), cause),
    }).pipe(
      Effect.tapError(() => cleanupPreparation(directory, input.extractedPath))
    );
    yield* Effect.forEach(
      backups,
      (backup) =>
        Effect.tryPromise({
          try: async () => {
            await fs.mkdir(dirname(backup.backupPath), { recursive: true });
            await fs.copyFile(
              resolveInside(input.installationPath, backup.installedPath),
              backup.backupPath,
              constants.COPYFILE_FICLONE
            );
          },
          catch: (cause) => fileError(backup.installedPath, cause),
        }),
      { concurrency: 1, discard: true }
    ).pipe(
      Effect.tapError(() => cleanupPreparation(directory, input.extractedPath))
    );
    const journal: TransactionJournal = { ...preparing, state: 'prepared' };
    yield* Effect.tryPromise({
      try: () => writeJsonAtomic(journalPath(id), journal),
      catch: (cause) => fileError(journalPath(id), cause),
    }).pipe(
      Effect.tapError(() => cleanupPreparation(directory, input.extractedPath))
    );
    yield* adoptStaging(input.extractedPath).pipe(
      Effect.catchAll((cause) =>
        rollbackTransaction(id).pipe(
          Effect.ignore,
          Effect.zipRight(Effect.fail(cause))
        )
      )
    );
    if (ownership) {
      const protectedPaths = new Set(
        filesToProtect.map((file) => file.installedPath)
      );
      yield* Effect.tryPromise({
        try: async () => {
          for (const owned of ownership.files) {
            if (!protectedPaths.has(owned.installedPath) || !owned.sourcePath)
              continue;
            const destination = resolveInside(
              input.installationPath,
              owned.installedPath
            );
            const target = targetByPath.get(owned.sourcePath);
            if (!target) {
              await fs.rm(destination, { force: true });
              continue;
            }
            const source = resolveInside(input.extractedPath, target.path);
            await fs.mkdir(dirname(destination), { recursive: true });
            await fs.copyFile(source, destination);
          }
        },
        catch: (cause) => fileError(input.installationPath, cause),
      }).pipe(
        Effect.catchAll((cause) =>
          rollbackTransaction(id).pipe(
            Effect.ignore,
            Effect.zipRight(Effect.fail(cause))
          )
        )
      );
    }
    return { transactionId: id, setupPath: input.extractedPath };
  });
}

export function commitTransaction(
  transactionId: string,
  manifest: UpdateManifest,
  installationPath: string,
  expectedLibrary: ExpectedLibraryUpdate
): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    const journal = yield* readJournal(transactionId);
    const committing: TransactionJournal = {
      ...journal,
      expectedLibrary,
      state: 'committing',
    };
    yield* Effect.tryPromise({
      try: () => writeJsonAtomic(journalPath(transactionId), committing),
      catch: (cause) => fileError(journalPath(transactionId), cause),
    });
    const previous = yield* loadOwnership(journal.appID);
    yield* restoreUnknownFiles(journal, manifest, previous);
    const installed = yield* scanFiles(installationPath);
    const files = captureOwnershipFiles(
      manifest,
      installed,
      journal.beforeFiles,
      previous
    );
    const capturedSources = new Set(files.map((file) => file.sourcePath));
    const targetSources = new Set(manifest.entries.map((entry) => entry.path));
    const installedPaths = new Set(installed.map((file) => file.path));
    const missingManagedOutput = previous?.files.some(
      (file) =>
        file.sourcePath !== undefined &&
        ((targetSources.has(file.sourcePath) &&
          !capturedSources.has(file.sourcePath)) ||
          (!targetSources.has(file.sourcePath) &&
            installedPaths.has(file.installedPath)))
    );
    if (missingManagedOutput) {
      return yield* Effect.fail(
        new FileSystemError({
          message: 'Final installation does not match the managed update',
          path: installationPath,
        })
      );
    }
    const ownership: OwnershipManifest = {
      schemaVersion: 1,
      appID: journal.appID,
      root: installationPath,
      sourceSetKey: manifest.sourceSetKey,
      transactionId,
      files,
    };
    yield* Effect.tryPromise({
      try: () => writeJsonAtomic(ownershipPath(journal.appID), ownership),
      catch: (cause) => fileError(ownershipPath(journal.appID), cause),
    });
  });
}

export function completeTransaction(
  transactionId: string
): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    const journal = yield* readJournal(transactionId);
    const ownership = yield* loadOwnership(journal.appID);
    const library = loadLibraryInfo(journal.appID);
    if (
      journal.state !== 'committing' ||
      ownership?.transactionId !== journal.id ||
      !libraryMatches(library, journal.expectedLibrary)
    ) {
      return yield* Effect.fail(
        new FileSystemError({
          message: 'Update transaction is not fully committed',
          path: journal.root,
        })
      );
    }
    yield* removeTransactionFiles(journal);
  });
}

export function rollbackTransaction(
  transactionId: string
): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    const journal = yield* readJournal(transactionId);
    const beforePaths = new Set(journal.beforeFiles.map((file) => file.path));
    const current = yield* scanFiles(journal.root).pipe(
      Effect.catchAll(() => Effect.succeed([]))
    );
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of current) {
          if (!beforePaths.has(file.path)) {
            await fs.rm(resolveInside(journal.root, file.path), {
              force: true,
            });
          }
        }
        for (const backup of journal.backups) {
          const destination = resolveInside(journal.root, backup.installedPath);
          await fs.mkdir(dirname(destination), { recursive: true });
          await fs.copyFile(backup.backupPath, destination);
        }
        if (journal.previousOwnership) {
          await writeJsonAtomic(
            ownershipPath(journal.appID),
            journal.previousOwnership
          );
        } else {
          await fs.rm(ownershipPath(journal.appID), { force: true });
        }
        if (journal.previousLibrary) {
          saveLibraryInfo(journal.appID, journal.previousLibrary);
        }
        await fs.rm(journal.extractedPath, { recursive: true, force: true });
        await fs.rm(join(transactionDirectory, transactionId), {
          recursive: true,
          force: true,
        });
      },
      catch: (cause) => fileError(journal.root, cause),
    });
  });
}

export function recoverTransactions(): Effect.Effect<void, FileSystemError> {
  return Effect.tryPromise({
    try: () => fs.readdir(transactionDirectory, { withFileTypes: true }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll(() => Effect.succeed([])),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter(
          (entry) => entry.isDirectory() && !entry.name.endsWith('.quarantined')
        ),
        (entry) => recoverTransaction(entry.name),
        { concurrency: 1, discard: true }
      )
    )
  );
}

function recoverTransaction(id: string): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    // A directory with NO journal file means we crashed before the journal
    // write — nothing was backed up or mutated yet, so discard it. A journal
    // that exists but cannot be read may still guard rollback copies for a
    // mutated installation: quarantine it (rename) rather than delete, and
    // never let either case block startup.
    const journal = yield* readJournal(id).pipe(
      Effect.catchAll(() =>
        Effect.tryPromise({
          try: async () => {
            const directory = join(transactionDirectory, id);
            const journalExists = await fs
              .stat(journalPath(id))
              .then(() => true)
              .catch(() => false);
            if (journalExists) {
              await fs.rename(directory, `${directory}.quarantined`);
            } else {
              await fs.rm(directory, { recursive: true, force: true });
            }
          },
          catch: (cause) => fileError(join(transactionDirectory, id), cause),
        }).pipe(Effect.as(undefined))
      )
    );
    if (!journal) return;
    if (journal.state === 'preparing') {
      yield* removeStaging(journal.extractedPath);
      yield* Effect.tryPromise({
        try: () =>
          fs.rm(join(transactionDirectory, id), {
            recursive: true,
            force: true,
          }),
        catch: (cause) => fileError(journal.root, cause),
      });
      return;
    }
    if (journal.state === 'committing') {
      const ownership = yield* loadOwnership(journal.appID);
      const library = loadLibraryInfo(journal.appID);
      if (
        ownership?.transactionId === journal.id &&
        libraryMatches(library, journal.expectedLibrary)
      ) {
        yield* removeTransactionFiles(journal);
        return;
      }
    }
    yield* rollbackTransaction(id);
  });
}

function libraryMatches(
  library: LibraryInfo | null | undefined,
  expected: ExpectedLibraryUpdate | undefined
): boolean {
  return Boolean(
    library &&
      expected &&
      library.version === expected.version &&
      library.cwd === expected.cwd &&
      library.launchExecutable === expected.launchExecutable &&
      library.launchArguments === expected.launchArguments &&
      library.addonsource === expected.addonSource
  );
}

function restoreUnknownFiles(
  journal: TransactionJournal,
  manifest: UpdateManifest,
  previous: OwnershipManifest | undefined
): Effect.Effect<void, FileSystemError> {
  const managedPaths = new Set(
    previous
      ? previous.files.map((file) => file.installedPath)
      : manifest.entries.map((entry) => entry.path)
  );
  const backups = new Map(
    journal.backups.map((backup) => [backup.installedPath, backup.backupPath])
  );
  return Effect.tryPromise({
    try: async () => {
      for (const file of journal.beforeFiles) {
        if (managedPaths.has(file.path)) continue;
        const backup = backups.get(file.path);
        if (!backup) throw new Error(`Missing rollback copy for ${file.path}`);
        const destination = resolveInside(journal.root, file.path);
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.copyFile(backup, destination);
      }
    },
    catch: (cause) => fileError(journal.root, cause),
  });
}

function removeTransactionFiles(
  journal: TransactionJournal
): Effect.Effect<void, FileSystemError> {
  return Effect.tryPromise({
    try: async () => {
      await fs.rm(journal.extractedPath, { recursive: true, force: true });
      await fs.rm(join(transactionDirectory, journal.id), {
        recursive: true,
        force: true,
      });
    },
    catch: (cause) => fileError(journal.root, cause),
  });
}

function cleanupPreparation(
  directory: string,
  extractedPath: string
): Effect.Effect<void> {
  return Effect.promise(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await Effect.runPromise(removeStaging(extractedPath));
  });
}

function readJournal(
  id: string
): Effect.Effect<TransactionJournal, FileSystemError> {
  const path = journalPath(id);
  return Effect.gen(function* () {
    if (!isValidTransactionId(id)) {
      return yield* Effect.fail(
        fileError(path, `Invalid transaction id: ${id}`)
      );
    }
    const raw = yield* Effect.tryPromise({
      try: async (): Promise<unknown> =>
        JSON.parse(await fs.readFile(path, 'utf8')),
      catch: (cause) => fileError(path, cause),
    });
    return (yield* Schema.decodeUnknown(TransactionJournalSchema)(raw).pipe(
      Effect.mapError((cause) => fileError(path, cause))
    )) as TransactionJournal;
  });
}
