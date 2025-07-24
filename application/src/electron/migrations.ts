import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { join } from 'path';
import { __dirname } from './paths.js';
import semver from 'semver';
import { VERSION } from './main.js';

let migrations: {
  [key: string]: {
    from: string;
    to: string;
    description: string;
    run: () => Promise<void>;
  };
} = {
  'install-steam-addon': {
    from: '1.6.8',
    to: '2.0.0',
    description: `Adds the Steam Catalog addon to the user's addons list. This is required because the user expects Steam listings to appear, but because the built-in Steam catalog was removed, this addon is needed to provide the same functionality.`,
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
    },
  },
};
export async function execute() {
  // check if the thing is even installed, if not, don't run any migrations because it was just installed
  if (!fsSync.existsSync(join(__dirname, 'config/option/installed.json'))) {
    // no need to run migrations
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
  // enroll into certain migrations
  for (const migration of Object.keys(migrations)) {
    if (semver.lt(lastVersion, migrations[migration].from)) {
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
