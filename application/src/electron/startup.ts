import { exec } from 'child_process';
import { __dirname } from './manager/manager.paths.js';
import { join } from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { LibraryInfo } from 'ogi-addon';
import { app, BrowserWindow } from 'electron';
import { sendNotification } from './main.js';
import semver from 'semver';

// check if NixOS using command -v nixos-rebuild
export const IS_NIXOS = await (() => {
  return new Promise<boolean>((resolve) => {
    try {
      exec('command -v nixos-rebuild', (error, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          resolve(false);
          return;
        }
        if (stderr.includes('nixos-rebuild')) {
          resolve(true);
          return;
        }
        resolve(false);
      });
    } catch (error) {
      console.error(`exec error: ${error}`);
      resolve(false);
    }
  });
})();
console.log('continuing launch...');
export let STEAMTINKERLAUNCH_PATH = join(
  __dirname,
  'bin/steamtinkerlaunch/steamtinkerlaunch'
);
async function fetch_STLPath() {
  return new Promise<void>((resolve) => {
    exec('which steamtinkerlaunch', (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }

      // The path will be returned as a string in stdout.
      const path = stdout.trim(); // Remove any extra newlines or spaces.
      STEAMTINKERLAUNCH_PATH = path;
      resolve();
    });
  });
}
console.log('NIXOS: ' + IS_NIXOS);
if (IS_NIXOS) await fetch_STLPath();
if (STEAMTINKERLAUNCH_PATH === '') {
  STEAMTINKERLAUNCH_PATH = join(
    __dirname,
    'bin/steamtinkerlaunch/steamtinkerlaunch'
  );
  console.error(
    'STEAMTINKERLAUNCH_PATH is empty. Using default path to prevent issues.'
  );
}

export function restoreBackup() {
  // restore the backup if it exists
  if (
    fs.existsSync(join(app.getPath('temp'), 'ogi-update-backup')) &&
    process.platform === 'win32'
  ) {
    // restore the backup
    const directory = join(app.getPath('temp'), 'ogi-update-backup');
    console.log('[backup] Restoring backup...');
    for (const file of fs.readdirSync(directory)) {
      console.log('[backup] Restoring ' + file);
      fs.cpSync(join(directory, file), join(__dirname, file), {
        recursive: true,
        force: true,
      });
      console.log('[backup] Restored ' + file);
    }

    // remove the backup
    fs.rmdirSync(directory, { recursive: true });
    console.log('[backup] Backup restored successfully!');
  }
}

export async function convertLibrary() {
  // read the library directory
  const libraryPath = join(__dirname, 'library/');
  if (!fs.existsSync(libraryPath)) {
    return;
  }
  const files = fs.readdirSync(libraryPath);
  for (const file of files) {
    const filePath = join(libraryPath, file);
    const fileData = fs.readFileSync(filePath, 'utf-8');
    let data: LibraryInfo & { steamAppID?: number } = JSON.parse(fileData);
    if (data.steamAppID) {
      // convert the app id to an appID
      data.appID = data.steamAppID;
      delete data.steamAppID;
      data.coverImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/library_hero.jpg`;
      data.titleImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/logo_2x.png`;
      data.addonsource = 'steam';
      data.storefront = 'steam';
      fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
      console.log(`Converted ${file} to new format`);
    }
  }
}
async function checkForGitUpdates(repoPath: string): Promise<boolean> {
  // Change the directory to the repository path and run 'git fetch --dry-run'
  return new Promise((resolve, _) => {
    exec('git fetch --dry-run', { cwd: repoPath }, (error, stdout, stderr) => {
      if (error) {
        sendNotification({
          message: 'Failed to check for updates',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        console.log(error);
        resolve(false);
        return;
      }

      // If stdout is not empty, it means there are updates
      // auto remove the warning:
      const output = stdout + stderr;
      const cleanedOutput = output.replace(/warning: redirecting to .*/, '');
      console.log(cleanedOutput);

      if (cleanedOutput.trim()) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

export function checkForAddonUpdates(mainWindow: BrowserWindow) {
  if (!fs.existsSync(join(__dirname, 'addons'))) {
    return;
  }
  const generalConfig = JSON.parse(
    fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8')
  );
  const addons = generalConfig.addons;
  for (const addon of addons) {
    let addonPath = '';
    let addonName = addon.split(/\/|\\/).pop()!!;
    if (addon.startsWith('local:')) {
      addonPath = addon.split('local:')[1];
    } else {
      addonPath = join(__dirname, 'addons', addonName);
    }

    if (!fs.existsSync(addonPath + '/.git')) {
      console.log(`Addon ${addonName} is not a git repository`);
      continue;
    }

    new Promise<void>(async (resolve, _) => {
      const isUpdate = await checkForGitUpdates(addonPath);
      if (isUpdate) {
        sendNotification({
          message: `Addon ${addonName} has updates.`,
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
        mainWindow!!.webContents.send('addon:update-available', addon);
        console.log(`Addon ${addonName} has updates.`);
        resolve();
      }
      console.log(`Addon ${addonName} is up to date.`);
      resolve();
    });
  }
}

export function removeCachedAppUpdates() {
  // find cached updates in the temp folder of this system
  new Promise<void>(async (resolve, _) => {
    const tempFolder = app.getPath('temp');
    const cachedUpdates = (await fsPromises.readdir(tempFolder)).filter(
      (file) => file.startsWith('ogi-')
    );

    // count how many cached updates there are, then sort from oldest to newest based on ogi-{version}-cache using semver
    const sortedUpdates = cachedUpdates.sort((a, b) => {
      const aVersion = a.split('-')[1];
      const bVersion = b.split('-')[1];
      if (aVersion.includes('update')) {
        return 1;
      }
      if (bVersion.includes('update')) {
        return -1;
      }
      return semver.compare(aVersion, bVersion);
    });

    // remove all but the latest of 3 cached updates
    for (const update of sortedUpdates.slice(3)) {
      await fsPromises.rmdir(join(tempFolder, update), { recursive: true });
    }

    // remove all cached updates that are older than 30 days
    for (const update of sortedUpdates) {
      const updateDate = new Date(update.split('-')[1]);
      const diffTime = Math.abs(Date.now() - updateDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 30) {
        await fsPromises.rmdir(join(tempFolder, update), { recursive: true });
      }
    }

    console.log('[chore] Removed cached app updates');
    resolve();
  }).catch((error) => {
    console.error('[chore] Failed to remove cached app updates', error);
  });
}
