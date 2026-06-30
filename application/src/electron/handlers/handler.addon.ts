import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import fsAsync from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { exec, spawn } from 'child_process';
import { Addon } from '@/electron/manager/manager.addon.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import {
  port,
  startAddonServer,
  stopAddonServer,
} from '@/electron/server/addon-server.js';
import { sendIPCMessage, sendNotification } from '@/electron/main.js';
import axios from 'axios';
import { AddonConnection } from '@ogi-sdk/addon-server';
import { deleteInstalledAddon } from '@/electron/server/addon-lifecycle.js';
import { waitForAddonsConfigured } from '@/electron/manager/manager.addon-readiness.js';

function isGitRepository(addonPath: string): boolean {
  if (!fs.existsSync(addonPath)) {
    return false;
  }

  const gitPath = join(addonPath, '.git');
  if (!fs.existsSync(gitPath)) {
    return false;
  }

  const stat = fs.statSync(gitPath);
  if (stat.isDirectory()) {
    return (
      fs.existsSync(join(gitPath, 'HEAD')) &&
      fs.existsSync(join(gitPath, 'config'))
    );
  }

  if (stat.isFile()) {
    const gitFile = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = gitFile.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return false;
    }
    const gitDir = match[1];
    const resolvedGitDir = isAbsolute(gitDir)
      ? gitDir
      : resolve(dirname(gitPath), gitDir);
    return fs.existsSync(join(resolvedGitDir, 'HEAD'));
  }

  return false;
}

export async function startAddons(): Promise<void> {
  // start all of the addons
  if (!fs.existsSync(join(__dirname, 'config/option/general.json'))) {
    return;
  }

  const generalConfig = JSON.parse(
    fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8')
  );
  const addons = generalConfig.addons as string[];
  let promises: Promise<AddonConnection | undefined>[] = [];
  for (const addon of addons) {
    let addonPath = '';
    if (addon.startsWith('local:')) {
      addonPath = addon.split('local:')[1];
    } else {
      addonPath = join(__dirname, 'addons', addon.split(/\/|\\/).pop()!!);
    }

    if (!fs.existsSync(addonPath)) {
      console.error(`Addon ${addonPath} does not exist`);
      sendNotification({
        message: `Addon ${addonPath} does not exist`,
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      continue;
    }

    if (!fs.existsSync(join(addonPath, 'installation.log'))) {
      console.log(`Addon ${addonPath} has not been installed yet.`);
      continue;
    }

    console.log(`Starting addon ${addonPath}`);
    promises.push(
      (async () => {
        const instance = await Addon.load(addonPath);
        if (!instance) {
          return undefined;
        }
        return instance.startRegistered(addon);
      })()
    );
  }
  await Promise.allSettled(promises);
  console.log('All addons started');
}

const HEALTH_CHECK_INTERVAL_MS = 500;
const MAX_ATTEMPTS_HEALTH_CHECK = 60;
const HEALTH_CHECK_TIMEOUT_MS =
  MAX_ATTEMPTS_HEALTH_CHECK * HEALTH_CHECK_INTERVAL_MS;
export async function restartAddonServer(): Promise<void> {
  // stop the server
  console.log('Stopping server...');
  await stopAddonServer();
  // stop all of the addons
  for (const instance of [...Addon.running.values()]) {
    console.log(`Stopping addon ${instance.config.path}`);
    instance.stop();
  }
  // start the server and wait for it to be listening before starting addons

  await startAddonServer();
  const checkHealth = async () => {
    try {
      await axios.get(`http://localhost:${port}/health`, { timeout: 500 });
      return true;
    } catch {
      return false;
    }
  };
  let attempts = 0;
  while (!(await checkHealth()) && attempts < MAX_ATTEMPTS_HEALTH_CHECK) {
    await new Promise((res) => setTimeout(res, HEALTH_CHECK_INTERVAL_MS));
    attempts++;
  }
  if (attempts === MAX_ATTEMPTS_HEALTH_CHECK) {
    throw new Error(
      `Failed to start addon server: health check failed after ${attempts} attempts (${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`
    );
  }
  console.log(`Addon Server is running on http://localhost:${port}`);
  console.log(`Server is being executed by electron!`);
  await startAddons();
  const configuredAddons = await waitForAddonsConfigured();
  for (const connection of configuredAddons) {
    await sendIPCMessage('addon-connected', connection.addonInfo!.id);
  }
  await sendIPCMessage('addon-runtime-ready');

  sendNotification({
    message: 'Addon server restarted successfully.',
    id: Math.random().toString(36).substring(7),
    type: 'success',
  });
}

export default function AddonManagerHandler(mainWindow: BrowserWindow) {
  ipcMain.handle('install-addons', async (_, addons) => {
    // addons is an array of URLs to the addons to install. these should be valid git repositories
    addons = Array.isArray(addons)
      ? addons
          .filter((addon) => typeof addon === 'string')
          .map((addon) => addon.trim())
          .filter(Boolean)
      : [];

    let stagedUpdate = JSON.parse(
      await fsAsync.readFile(
        join(__dirname, 'config', 'option', 'general.json'),
        { encoding: 'utf-8' }
      )
    ) as { addons: string[] };
    if (addons.length === 0) {
      sendNotification({
        message: 'No addons to install',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      return;
    }

    // check if git is installed
    if (!fs.existsSync(join(__dirname, 'addons/'))) {
      fs.mkdirSync(join(__dirname, 'addons/'));
    }

    // check if git is installed
    const gitInstalled = await new Promise<boolean>((resolve, _) => {
      exec('git --version', (err, stdout, _) => {
        if (err) {
          resolve(false);
        }
        console.log(stdout);
        resolve(true);
      });
    });
    if (!gitInstalled) {
      sendNotification({
        message: 'Git is not installed. Please install git and try again.',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      return;
    }

    for (const addon of addons) {
      const addonName = addon.split(/\/|\\/).pop()!!;
      const isLocal = addon.startsWith('local:');
      let addonPath = join(__dirname, `addons/${addonName}`);
      if (addon.startsWith('local:')) {
        addonPath = addon.split('local:')[1];
      }
      if (fs.existsSync(join(addonPath, 'installation.log'))) {
        console.log(`Addon ${addonName} already installed and setup.`);
        sendNotification({
          message: `Addon ${addonName} already installed and setup.`,
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
        continue;
      }

      if (!isLocal && !fs.existsSync(join(addonPath, 'addon.json'))) {
        // Validate git URL/SSH pattern before cloning
        const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/;
        if (!gitUrlPattern.test(addon)) {
          sendNotification({
            message: `Invalid git URL format for addon ${addonName}`,
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          const gitProcess = spawn('git', ['clone', addon, addonPath], {
            stdio: 'pipe',
          });

          let stdout = '';
          let stderr = '';

          gitProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
            console.log(data.toString());
          });

          gitProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            console.error(data.toString());
          });

          gitProcess.on('close', (code: number) => {
            if (code !== 0) {
              sendNotification({
                message: `Failed to install addon ${addonName}`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              console.error(`git clone exited with code ${code}: ${stderr}`);
              reject(new Error(`git clone failed with code ${code}`));
              return;
            }
            console.log(stdout);
            resolve();
          });

          gitProcess.on('error', (err: Error) => {
            sendNotification({
              message: `Failed to install addon ${addonName}`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
            console.error(err);
            reject(err);
          });
        });
      }

      const instance = await Addon.load(addonPath);
      const hasAddonBeenSetup = instance ? await instance.install() : false;
      if (!hasAddonBeenSetup) {
        sendNotification({
          message: `An error occurred when setting up ${addonName}`,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
      } else {
        sendNotification({
          message: `Addon ${addonName} installed successfully.`,
          id: Math.random().toString(36).substring(7),
          type: 'success',
        });
        stagedUpdate.addons.push(addonPath);
      }
    }
    await fsAsync.writeFile(
      join(__dirname, 'config', 'option', 'general.json'),
      JSON.stringify(stagedUpdate),
      'utf-8'
    );
    await restartAddonServer();
    return stagedUpdate.addons;
  });

  ipcMain.handle('restart-addon-server', async (_) => {
    await restartAddonServer();
  });

  ipcMain.handle('addon:delete-installed', async (_, addonID: string) => {
    if (typeof addonID !== 'string' || addonID.trim().length === 0) {
      return { success: false, message: 'Invalid addon ID' };
    }
    return deleteInstalledAddon(addonID);
  });

  ipcMain.handle('clean-addons', async (_) => {
    for (const instance of [...Addon.running.values()]) {
      console.log(`Stopping addon ${instance.config.path}`);
      instance.stop();
    }

    // delete all of the addons
    fs.rmSync(join(__dirname, 'addons/'), { recursive: true, force: true });
    fs.mkdirSync(join(__dirname, 'addons/'));

    sendNotification({
      message: 'Successfully cleaned addons.',
      id: Math.random().toString(36).substring(7),
      type: 'info',
    });
  });

  ipcMain.handle('update-addons', async (_) => {
    // check if wifi is available
    const isWifiAvailable = await new Promise<boolean>((resolve, _) => {
      const req = axios.get('https://www.google.com');
      req
        .then(() => {
          resolve(true);
        })
        .catch(() => {
          resolve(false);
        });
    });
    if (!isWifiAvailable) {
      console.error('No internet connection. Not updating addons.');
      return;
    }

    for (const instance of [...Addon.running.values()]) {
      console.log(`Stopping addon ${instance.config.path}`);
      instance.stop();
    }

    // pull all of the addons
    if (!fs.existsSync(join(__dirname, 'addons/'))) {
      return;
    }
    const generalConfig = JSON.parse(
      fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8')
    );
    const addons = generalConfig.addons as string[];

    const updatePromises: Promise<void>[] = [];

    for (const addon of addons) {
      let addonPath = '';
      if (addon.startsWith('local:')) {
        addonPath = addon.split('local:')[1];
      } else {
        addonPath = join(__dirname, 'addons', addon.split(/\/|\\/).pop()!!);
      }
      if (!isGitRepository(addonPath)) {
        console.log(
          `Skipping addon update for ${addon}: ${addonPath} is not a valid git repository`
        );
        // Treat skipped non-git/corrupt addon installs as resolved so promise indexes stay aligned.
        updatePromises.push(Promise.resolve());
        continue;
      }

      const updatePromise = new Promise<void>((resolve, reject) => {
        exec(
          `git pull`,
          { cwd: addonPath, env: { ...process.env, LANG: 'en_US.UTF-8' } },
          (err, stdout, _) => {
            if (err) {
              sendNotification({
                message: `Failed to update addon ${addon}`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              console.error(err);
              reject(
                new Error(`Failed to update addon ${addon}: ${err.message}`)
              );
              return;
            }
            console.log(stdout);

            const installationLog = join(addonPath, 'installation.log');
            const isAlreadyUpToDate =
              stdout.includes('Already up to date.') ||
              stdout.includes('Already up-to-date.');

            if (isAlreadyUpToDate && fs.existsSync(installationLog)) {
              sendNotification({
                message: `Addon ${addon} is already up to date.`,
                id: Math.random().toString(36).substring(7),
                type: 'info',
              });
              mainWindow!!.webContents.send('addon:updated', addon);
              resolve();
              return;
            }

            if (isAlreadyUpToDate) {
              console.log(
                `Addon ${addon} is already up to date, but installation.log is missing. Running setup.`
              );
            } else if (fs.existsSync(installationLog)) {
              // get rid of the installation log because not up-to-date
              fs.unlinkSync(installationLog);
            }

            void Addon.load(addonPath).then(async (instance) => {
              if (!instance) {
                reject(new Error(`Failed to load addon ${addon}`));
                return;
              }
              try {
                const success = await instance.install();
                if (!success || !fs.existsSync(installationLog)) {
                  sendNotification({
                    message: `An error occurred when setting up ${addon}`,
                    id: Math.random().toString(36).substring(7),
                    type: 'error',
                  });
                  reject(new Error(`Failed to setup addon ${addon}`));
                  return;
                }

                sendNotification({
                  message: isAlreadyUpToDate
                    ? `Addon ${addon} setup completed successfully.`
                    : `Addon ${addon} updated successfully.`,
                  id: Math.random().toString(36).substring(7),
                  type: 'info',
                });
                mainWindow!!.webContents.send('addon:updated', addon);
                console.log(`Addon ${addon} updated and setup successfully.`);
                resolve();
              } catch (setupErr) {
                sendNotification({
                  message: `An error occurred when setting up ${addon}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                reject(setupErr);
              }
            });
          }
        );
      });

      updatePromises.push(updatePromise);
    }

    const results = await Promise.allSettled(updatePromises);
    let failedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failedCount++;
        console.error(
          `Addon update failed for ${addons[index]}:`,
          result.reason
        );
      }
    });

    if (failedCount > 0) {
      console.log(`${failedCount} addons failed to update.`);
    }

    // restart all of the addons
    await restartAddonServer();

    sendNotification({
      message: 'Successfully updated addons.',
      id: Math.random().toString(36).substring(7),
      type: 'info',
    });
  });
}
