import { app } from 'electron';
import path, { join } from 'path';
import os from 'os';
import fs from 'fs';

export function isDev() {
  return !app.isPackaged;
}

export let __dirname = isDev()
  ? app.getAppPath() + '/development'
  : path.dirname(process.execPath);

if (process.platform === 'linux' && !isDev()) {
  // it's most likely sandboxed, so just use ./
  // check if the folder exists
  // get the home directory
  let home = os.homedir();
  if (!fs.existsSync(join(home, '.local/share/OpenGameInstaller'))) {
    fs.mkdirSync(join(home, '.local/share/OpenGameInstaller'), {
      recursive: true,
    });
  }
  __dirname = join(home, '.local/share/OpenGameInstaller');
}

const OGI_DIRECTORY = process.env.OGI_DIRECTORY;
if (OGI_DIRECTORY) __dirname = OGI_DIRECTORY;
