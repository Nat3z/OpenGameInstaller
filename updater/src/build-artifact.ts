import fs from 'node:fs';
import path from 'node:path';

/** Stage the complete build before replacing a working installation. */
export function installBleedingEdgeArtifact(
  repoDir: string,
  destination: string,
  platform: NodeJS.Platform,
  preservedEntries: ReadonlySet<string>
): void {
  const dist = path.join(repoDir, 'application', 'dist');
  const windows = platform === 'win32';
  if (!windows && platform !== 'linux') {
    throw new Error(`Bleeding-edge builds are unsupported on ${platform}`);
  }
  const source = windows
    ? path.join(dist, 'win-unpacked')
    : path.join(dist, 'OpenGameInstaller-linux-pt.AppImage');
  const executable = windows
    ? path.join(source, 'OpenGameInstaller.exe')
    : source;
  if (!fs.statSync(executable).isFile()) {
    throw new Error(`Built application not found: ${executable}`);
  }
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.ogi-build-'));
  const staged = path.join(temporary, 'staged');
  const backup = path.join(temporary, 'previous');
  try {
    fs.mkdirSync(staged);
    if (windows) {
      fs.cpSync(source, staged, { recursive: true });
    } else {
      const target = path.join(staged, 'OpenGameInstaller.AppImage');
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
    }
    for (const entry of preservedEntries) {
      const previous = path.join(destination, entry);
      if (fs.existsSync(previous)) {
        fs.cpSync(previous, path.join(staged, entry), { recursive: true });
      }
    }
    const hadInstallation = fs.existsSync(destination);
    if (hadInstallation) fs.renameSync(destination, backup);
    try {
      fs.renameSync(staged, destination);
    } catch (error) {
      if (hadInstallation) fs.renameSync(backup, destination);
      throw error;
    }
  } finally {
    // Keep the previous install if rollback itself failed.
    if (fs.existsSync(destination)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
