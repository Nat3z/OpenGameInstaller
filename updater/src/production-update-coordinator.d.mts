import type {
  InstallationManifest,
  StartupHealth,
  TransactionFilesystem,
} from './update-engine.mjs';

export const PRODUCTION_UPDATE_COORDINATOR_MARKER: string;
export type ProcessIdentity = {
  pid: number;
  startTime: string;
  executable: string;
  transactionToken: string;
  proofBound?: boolean;
  processRole?: 'application' | 'windows-job-wrapper';
  windowsJobWrapperToken?: string;
  applicationPid?: number;
  windowsJobStopPath?: string;
  windowsJobResultPath?: string;
};
export type ProductionTransactionPaths = {
  stateRoot: string;
  workingPath: string;
  candidatePath?: string;
  backupPath: string;
  retiredBackupPath: string;
  journalPath: string;
  metadataPath?: string;
};
export type TransactionJournal = {
  version: 2;
  transactionId: string;
  transactionToken: string;
  phase:
    | 'prepared'
    | 'candidate-active'
    | 'restored'
    | 'recovery-active'
    | 'recovery-launched'
    | 'recovery-healthy'
    | 'committed';
  previousVersion: string;
  targetVersion: string;
  workingPath: string;
  candidatePath: string;
  backupPath: string;
  retiredBackupPath: string;
  createdAt: string;
  backupManifest: InstallationManifest;
  candidateManifest: InstallationManifest;
  launchIntent?: {
    role: 'candidate' | 'recovery';
    executable: string;
    transactionToken: string;
    requestedAt: string;
    allowProofBoundExecTransition?: true;
    launcherDigest?: string;
    windowsJob?: {
      wrapperExecutable: string;
      wrapperScript: string;
      wrapperToken: string;
      launchPath: string;
      resultPath: string;
      stopPath: string;
    };
  };
  targetMetadata?: { version: string; digest: string };
  verifiedHealth?: StartupHealth & {
    pid: number;
    transactionToken: string;
  };
  activeProcess?: ProcessIdentity;
};
export type ProductionDurabilityAdapter = {
  replace(source: string, destination: string): void;
  durableRename(source: string, destination: string): void;
  getRenameConfirmationPath?(destination: string): string;
  confirmAppliedRename?(destination: string, directories?: string[]): void;
  syncDirectories(paths: string[]): void;
};
export function createProductionDurabilityAdapter(input?: {
  platform?: NodeJS.Platform;
  runWindowsHelper?: (script: string) => {
    status: number | null;
    stderr?: string;
    error?: Error;
  };
}): ProductionDurabilityAdapter;
export function writeDurableVersionMetadata(input: {
  path: string;
  version: string;
  fault?: (stage: string) => void;
  durability?: ProductionDurabilityAdapter;
}): { version: string; digest: string };
export function verifyDurableVersionMetadata(input: {
  path: string;
  expected: { version: string; digest: string };
  repair?: boolean;
  durability?: ProductionDurabilityAdapter;
}): { version: string; digest: string };
export function writeTransactionJournal(input: {
  journalPath: string;
  stateRoot: string;
  journal: TransactionJournal;
  fault?: (stage: string) => void;
  durability?: ProductionDurabilityAdapter;
}): TransactionJournal;
export function readValidatedTransactionJournal(input: {
  journalPath: string;
  stateRoot: string;
  expectedPaths: Partial<ProductionTransactionPaths>;
}): {
  journal: TransactionJournal | null;
  source: 'current' | 'last-known-good' | 'none';
  diagnostics: string[];
};
export function stopOwnedProcess(input: {
  expectedIdentity?: ProcessIdentity;
  terminateOwnedProcess?: (identity: ProcessIdentity) => Promise<{
    processStopped?: boolean;
    processExited?: boolean;
    processTreeStopped?: boolean;
  }>;
}): Promise<{ processStopped: true; processTreeStopped: true }>;
export function installPreparedProductionUpdate(
  input: Record<string, unknown>
): Promise<StartupHealth>;
export function recoverInterruptedProductionUpdate(
  input: Record<string, unknown>
): Promise<{
  recovered: boolean;
  committed: boolean;
  recoveryHealth?: StartupHealth;
  preparedDiscarded?: boolean;
}>;
