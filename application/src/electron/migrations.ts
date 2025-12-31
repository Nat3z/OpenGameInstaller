import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { join } from 'path';
import { __dirname } from './manager/manager.paths.js';
import semver from 'semver';
import { sendNotification, VERSION } from './main.js';
import { sendIPCMessage } from './main.js';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import { addToDesktop } from './handlers/handler.app.js';

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
    to: '2.1.0',
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
  'install-flatpak-wine': {
    from: '2.1.2',
    to: '2.2.0',
    description:
      'Installs flatpak wine if not already installed on Linux systems.',
    platform: 'linux',
    run: async () => {
      // Check if flatpak is installed
      const flatpakInstalled = await new Promise<boolean>((resolve) => {
        exec('flatpak --version', (err, stdout) => {
          if (err) {
            console.log('[migration] flatpak not installed');
            resolve(false);
          } else {
            console.log('[migration] flatpak version:', stdout.trim());
            resolve(true);
          }
        });
      });

      if (!flatpakInstalled) {
        console.log(
          '[migration] flatpak not available, skipping wine installation'
        );
        return;
      }

      // Check if wine is already installed
      const wineInstalled = await new Promise<boolean>((resolve) => {
        exec('flatpak run org.winehq.Wine --help', (err) => {
          if (err) {
            console.log('[migration] wine not installed via flatpak');
            resolve(false);
          } else {
            console.log('[migration] wine already installed via flatpak');
            resolve(true);
          }
        });
      });

      if (wineInstalled) {
        console.log('[migration] wine already installed, skipping');
        return;
      }

      // Install wine through flatpak
      console.log('[migration] installing wine via flatpak...');
      const result = await new Promise<boolean>((resolve) => {
        sendNotification({
          message: 'Installing wine via flatpak...',
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
        const childProcess = spawn(
          'flatpak',
          [
            'install',
            '--system',
            '-y',
            'flathub',
            'org.winehq.Wine/x86_64/stable-25.08',
          ],
          { cwd: __dirname }
        );

        let stdout = '';
        let stderr = '';

        if (childProcess.stdout) {
          childProcess.stdout.on('data', (data: Buffer) => {
            const dataStr = data.toString();
            stdout += dataStr;
            console.log('[migration] wine install stdout:', dataStr);
          });
        }

        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const dataStr = data.toString();
            stderr += dataStr;
            console.log('[migration] wine install stderr:', dataStr);
          });
        }

        childProcess.on('close', (code: number) => {
          console.log(
            '[migration] wine install process exited with code:',
            code
          );
          if (code !== 0) {
            console.log('[migration] wine installation failed');
            resolve(false);
            return;
          }
          console.log('[migration] wine installation successful');
          resolve(true);
        });

        childProcess.on('error', (err: Error) => {
          console.log('[migration] wine install error:', err);
          resolve(false);
        });
      });

      if (!result) {
        console.log('[migration] failed to install wine through flatpak');
        return;
      }

      // Verify wine installation
      const wineVerification = await new Promise<boolean>((resolve) => {
        exec('flatpak run org.winehq.Wine --help', (err) => {
          if (err) {
            console.log('[migration] wine verification failed');
            resolve(false);
          } else {
            console.log('[migration] wine verification successful');
            resolve(true);
          }
        });
      });

      if (!wineVerification) {
        console.log('[migration] wine installation verification failed');
      } else {
        console.log('[migration] wine installation completed successfully');
      }
    },
  },
  'changelog-explain-2.5.0': {
    from: '2.4.0',
    to: '2.5.0',
    description: 'Shows the changelog modal for the 2.5.0 update.',
    platform: 'all',
    run: async () => {
      await sendIPCMessage('app:show-changelog', '2.5.0');
    },
  },
  'add-to-desktop-2.5.0': {
    from: '2.5.0',
    to: '2.5.0',
    description: 'Adds a desktop shortcut for OpenGameInstaller',
    platform: 'linux',
    run: async () => {
      await addToDesktop();
      sendNotification({
        message:
          'Desktop shortcut created successfully. You can now find OpenGameInstaller in your Desktop.',
        id: Math.random().toString(36).substring(7),
        type: 'success',
      });
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
