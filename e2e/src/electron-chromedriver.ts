import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadArtifact } from '@electron/get';
import extractZip from 'extract-zip';

const require = createRequire(import.meta.url);

type PrepareElectronChromedriverOptions = {
  destinationDirectory: string;
  electronVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  download?: typeof downloadArtifact;
  extract?: typeof extractZip;
};

export async function prepareElectronChromedriver(
  options: PrepareElectronChromedriverOptions
) {
  const electronVersion =
    options.electronVersion ??
    (require('electron/package.json') as { version: string }).version;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const destinationDirectory = resolve(options.destinationDirectory);
  const executableName =
    platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
  const executablePath = join(destinationDirectory, executableName);
  const readyPath = join(destinationDirectory, '.ready');
  const lockDirectory = `${destinationDirectory}.lock`;
  const deadline = Date.now() + 30_000;
  mkdirSync(dirname(destinationDirectory), { recursive: true });

  while (!existsSync(readyPath) || !existsSync(executablePath)) {
    try {
      mkdirSync(lockDirectory);
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Electron ${electronVersion} Chromedriver preparation`
        );
      }
      await delay(25);
    }
  }
  if (existsSync(readyPath) && existsSync(executablePath)) {
    return executablePath;
  }

  const stagingDirectory = `${destinationDirectory}.staging-${process.pid}-${randomUUID()}`;
  try {
    const archivePath = await (options.download ?? downloadArtifact)({
      version: electronVersion,
      artifactName: 'chromedriver',
      platform,
      arch,
    });
    mkdirSync(stagingDirectory, { recursive: true });
    await (options.extract ?? extractZip)(archivePath, {
      dir: stagingDirectory,
    });
    const stagedExecutablePath = join(stagingDirectory, executableName);
    if (!existsSync(stagedExecutablePath)) {
      throw new Error(
        `Electron ${electronVersion} Chromedriver is missing after extraction: ${stagedExecutablePath}`
      );
    }
    if (platform !== 'win32') chmodSync(stagedExecutablePath, 0o755);
    writeFileSync(join(stagingDirectory, '.ready'), `${electronVersion}\n`);
    mkdirSync(dirname(destinationDirectory), { recursive: true });
    rmSync(destinationDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, destinationDirectory);
    return executablePath;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}
