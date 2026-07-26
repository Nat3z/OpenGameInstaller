export type ReleaseArtifactMetadata = { size: number; digest: string };
export function verifyReleaseArtifact(
  artifactPath: string,
  expected: ReleaseArtifactMetadata,
  validateContent?: (artifactPath: string) => void | Promise<void>
): Promise<void>;
export function stageTransactionalCandidate(input: {
  workingPath: string;
  candidatePath: string;
  build: (candidatePath: string) => void | Promise<void>;
  validate?: (candidatePath: string) => void | Promise<void>;
}): Promise<string>;
export function stageVerifiedDownload(input: {
  workingPath: string;
  stagingDirectory: string;
  expected: ReleaseArtifactMetadata;
  download: (destination: string) => Promise<void>;
  validateContent?: (artifactPath: string) => void | Promise<void>;
}): Promise<string>;
export function assertIncrementalVersions(
  metadata: { fromVersion?: string; toVersion?: string },
  installedVersion: string,
  targetVersion: string
): void;
export function verifyBlockmapFile(
  artifactPath: string,
  file: unknown
): Promise<void>;
export function applyBlockmapPatch(input: {
  sourceArtifact: string;
  oldBlockmapPath: string;
  outputArtifact: string;
  newBlockmapPath: string;
  expectedArtifact: ReleaseArtifactMetadata;
  downloadRange: (start: number, end: number) => Promise<Buffer>;
  onProgress?: (current: number, total: number) => void;
}): Promise<string>;
export type InstallationManifest = {
  version: 1;
  digest: string;
  entries: Array<Record<string, unknown>>;
};
export function createInstallationManifest(root: string): InstallationManifest;
export function verifyInstallationManifest(
  root: string,
  expected: InstallationManifest
): InstallationManifest;
export type StartupHealth = {
  version: 1;
  state: 'interactive';
  processAlive: boolean;
  [key: string]: unknown;
};
export type TransactionFilesystem = {
  exists(target: string): boolean;
  rename(source: string, destination: string): void;
  durableRename?(
    source: string,
    destination: string,
    directories: string[]
  ): void;
  getRenameConfirmationPath?(destination: string): string;
  confirmAppliedRename?(destination: string, directories: string[]): void;
  remove(target: string): void;
  device(target: string): number;
  syncDirectories?(paths: string[]): void;
};
export function confirmAppliedTransactionRename(input: {
  fileSystem: TransactionFilesystem;
  sourcePath: string;
  destinationPath: string;
  expectedManifest?: InstallationManifest;
}): void;
export function restoreInterruptedTransaction(input: {
  workingPath: string;
  backupPath: string;
  expectedBackupManifest?: InstallationManifest;
  beforeRestore?: () =>
    | boolean
    | { processStopped: boolean }
    | Promise<boolean | { processStopped: boolean }>;
  fileSystem?: TransactionFilesystem;
  retry?: { attempts: number; delayMs: number };
}): Promise<boolean>;
export function transactionalReplaceAndRequireHealth(input: {
  workingPath: string;
  candidatePath: string;
  backupPath: string;
  retiredBackupPath?: string;
  expectedBackupManifest?: InstallationManifest;
  expectedCandidateManifest?: InstallationManifest;
  beforeRecovery?: () =>
    | boolean
    | { processStopped: boolean }
    | Promise<boolean | { processStopped: boolean }>;
  commitCandidate?: (health: StartupHealth) => void | Promise<void>;
  markCommitted?: (health: StartupHealth) => void | Promise<void>;
  markRestored?: () => void | Promise<void>;
  afterRestore?: () => void | Promise<void>;
  fileSystem?: TransactionFilesystem;
  retry?: { attempts: number; delayMs: number };
  launchAndWaitForHealth: (input: {
    recovery: boolean;
    workingPath: string;
  }) => Promise<StartupHealth>;
}): Promise<StartupHealth>;
export function resolveApplicationLauncher(
  installationDirectory: string,
  platform: 'linux' | 'win32'
): string;
