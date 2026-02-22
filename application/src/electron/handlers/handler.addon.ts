import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import { join } from 'path';
import { exec, spawn } from 'child_process';
import { processes, setupAddon, startAddon } from '../manager/manager.addon.js';
import { __dirname } from '../manager/manager.paths.js';
import { server, clients, port } from '../server/addon-server.js';
import { sendIPCMessage, sendNotification } from '../main.js';
import axios from 'axios';
import { AddonConnection } from '../server/AddonConnection.js';

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
    promises.push(startAddon(addonPath, addon));
  }
  await Promise.allSettled(promises);
  console.log('All addons started');

  // Wait for addons to send events-available so per-app update checks (checkForUpdates) can find them.
  // Addons send events-available after authenticate; without this wait, the frontend's
  // checkForAppUpdates can run before eventsAvailable is set and return 404 for every app.
  const expectedAddonCount = promises.length;
  if (expectedAddonCount > 0) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const clientList = Array.from(clients.values());
      const allReady =
        clientList.length >= expectedAddonCount &&
        clientList.every((c) => c.eventsAvailable.length > 0);
      if (allReady) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // sendIPCMessage waits for client-ready-for-events (with timeout) before sending
  await sendIPCMessage('all-addons-started');
}

export async function restartAddonServer(): Promise<void> {
  // stop the server
  console.log('Stopping server...');
  server.close();
  clients.clear();
  // stop all of the addons
  for (const process of Object.keys(processes)) {
    console.log(`Killing process ${process}`);
    const killed = processes[process].kill('SIGKILL');
    console.log(`Killed process ${process}: ${killed}`);
  }
  // start the server and wait for it to be listening before starting addons
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      console.log(`Addon Server is running on http://localhost:${port}`);
      console.log(`Server is being executed by electron!`);
      resolve();
    });
  });
  await startAddons();

  sendNotification({
    message: 'Addon server restarted successfully.',
    id: Math.random().toString(36).substring(7),
    type: 'success',
  });
}

export default function AddonManagerHandler(mainWindow: BrowserWindow) {
  ipcMain.handle('install-addons', async (_, addons) => {
    // addons is an array of URLs to the addons to install. these should be valid git repositories
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

      const hasAddonBeenSetup = await setupAddon(addonPath);
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
      }
    }
    await restartAddonServer();
    return;
  });

  ipcMain.handle('restart-addon-server', async (_) => {
    await restartAddonServer();
  });

  ipcMain.handle('clean-addons', async (_) => {
    // stop all of the addons
    for (const process of Object.keys(processes)) {
      console.log(`Killing process ${process}`);
      processes[process].kill('SIGKILL');
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

    // stop all of the addons
    for (const process of Object.keys(processes)) {
      console.log(`Killing process ${process}`);
      processes[process].kill('SIGKILL');
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
      if (!fs.existsSync(join(addonPath, '.git'))) {
        console.log(`Addon ${addon} is not a git repository`);
        // Treat skipped non-.git addons as resolved
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

            // Check if already up to date
            if (
              stdout.includes('Already up to date.') ||
              stdout.includes('Already up-to-date.')
            ) {
              sendNotification({
                message: `Addon ${addon} is already up to date.`,
                id: Math.random().toString(36).substring(7),
                type: 'info',
              });
              mainWindow!!.webContents.send('addon:updated', addon);
              // No need to run setupAddon if nothing changed
              resolve();
              return;
            }

            // get rid of the installation log because not up-to-date
            const installationLog = join(addonPath, 'installation.log');
            if (fs.existsSync(installationLog)) {
              fs.unlinkSync(installationLog);
            }

            sendNotification({
              message: `Addon ${addon} updated successfully.`,
              id: Math.random().toString(36).substring(7),
              type: 'info',
            });

            mainWindow!!.webContents.send('addon:updated', addon);
            // setup the addon
            setupAddon(addonPath)
              .then((success) => {
                if (!success) {
                  sendNotification({
                    message: `An error occurred when setting up ${addon}`,
                    id: Math.random().toString(36).substring(7),
                    type: 'error',
                  });
                  reject(new Error(`Failed to setup addon ${addon}`));
                  return;
                }
                console.log(`Addon ${addon} updated successfully.`);
                resolve();
              })
              .catch((setupErr) => {
                sendNotification({
                  message: `An error occurred when setting up ${addon}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                reject(setupErr);
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
