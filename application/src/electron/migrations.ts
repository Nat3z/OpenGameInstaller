import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { join } from 'path';
import { __dirname } from './paths.js';
import semver from 'semver';
import { VERSION } from './main.js';
import { sendIPCMessage } from './main.js';

let migrations: {
  [key: string]: {
    from: string;
    to: string;
    description: string;
    platform: 'linux' | 'win32' | 'all';
    run: () => Promise<void>;
  };
} = {
  'install-steam-addon': {
    from: '1.6.8',
    to: '2.0.0',
    description: `Adds the Steam Catalog addon to the user's addons list. This is required because the user expects Steam listings to appear, but because the built-in Steam catalog was removed, this addon is needed to provide the same functionality.`,
    platform: 'all',
    run: async () => {
      const generalConfig = await fs.readFile(
        join(__dirname, 'config/option/general.json'),
        'utf-8'
      );
      const generalConfigObj = JSON.parse(generalConfig);
      const addons = generalConfigObj.addons;
      const hasSteamAddon =
        addons.find((addon: string) =>
          addon.includes('Nat3z/steam-integration')
        ) !== undefined;
      if (!hasSteamAddon) {
        addons.push('https://github.com/Nat3z/steam-integration');
      }

      await fs.writeFile(
        join(__dirname, 'config/option/general.json'),
        JSON.stringify(generalConfigObj)
      );
      await new Promise<void>(async (resolve) => {
        await sendIPCMessage('migration:event', 'install-steam-addon');
        resolve();
      });
    },
  },
  'steamgriddb-launch': {
    from: '2.0.0',
    to: '2.0.7',
    description: `Launches the steamgriddb modal to fix the issue involving no images being resolved.`,
    platform: 'linux',
    run: async () => {
      await sendIPCMessage('migration:event', 'steamgriddb-launch');
    },
  },
  'install-steam-addon-repair': {
    from: '2.0.0',
    to: '2.0.8',
    description:
      'checks if the steam-addon was installed without an installation.log file and if so, repairs it.',
    platform: 'all',
    run: async () => {
      const generalConfig = await fs.readFile(
        join(__dirname, 'config/option/general.json'),
        'utf-8'
      );
      const generalConfigObj = JSON.parse(generalConfig);
      const addons = generalConfigObj.addons;
      const hasSteamAddon =
        addons.find((addon: string) =>
          addon.includes('Nat3z/steam-integration')
        ) !== undefined;
      if (!hasSteamAddon) {
        console.log(
          'user does not have steam-integration in config. no need to repair.'
        );
        return;
      }

      // check if installation.log exists in the addon path
      const addonPath = join(
        __dirname,
        'addons',
        'steam-integration',
        'installation.log'
      );
      if (fsSync.existsSync(addonPath)) {
        console.log('already installed, no need to repair.');
        return;
      }

      console.log('repairing steam-integration through installation...');
      await sendIPCMessage('migration:event', 'install-steam-addon');
    },
  },
};
export async function execute() {
  // check if the thing is even installed, if not, don't run any migrations because it was just installed
  if (!fsSync.existsSync(join(__dirname, 'config/option/installed.json'))) {
    // no need to run migrations, the person hasn't even launched anything.
    await fs.writeFile(
      join(__dirname, 'config/option/lastVersion.txt'),
      VERSION
    );
    return;
  }
  let lastVersion: string = '0.0.0';
  if (fsSync.existsSync(join(__dirname, 'config/option/lastVersion.txt'))) {
    lastVersion = await fs.readFile(
      join(__dirname, 'config/option/lastVersion.txt'),
      'utf-8'
    );
  }
  console.log('[migration] local version:', lastVersion);
  // enroll into certain migrations
  for (const migration of Object.keys(migrations)) {
    if (
      (semver.lt(lastVersion, migrations[migration].from) ||
        (semver.gte(lastVersion, migrations[migration].from) &&
          semver.lt(lastVersion, migrations[migration].to))) &&
      (migrations[migration].platform === 'all' ||
        migrations[migration].platform === process.platform)
    ) {
      console.log(
        `[migration] ${migrations[migration].description}\n - from: ${migrations[migration].from}\n - to: ${migrations[migration].to}`
      );
      try {
        await migrations[migration].run();
        console.log(`[migration] completed`);
      } catch (error) {
        console.error(`[migration] failed: ${error}`);
      }
    }
  }
  await fs.writeFile(join(__dirname, 'config/option/lastVersion.txt'), VERSION);
}
