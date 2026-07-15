import { AddonConnection } from '@ogi-sdk/addon-server';
import axios from 'axios';
import { exec } from 'child_process';
import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import fsAsync from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import {
  normalizeAddonLink,
  parseAddonLink,
} from '@/electron/lib/addon-links.js';
import { AddonMarketplace } from '@/electron/lib/marketplace.js';
import { tryCatch } from '@/electron/lib/tryCatch.js';
import { sendIPCMessage, sendNotification } from '@/electron/main.js';
import { Addon } from '@/electron/manager/manager.addon.js';
import { waitForAddonsConfigured } from '@/electron/manager/manager.addon-readiness.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { deleteInstalledAddon } from '@/electron/server/addon-lifecycle.js';
import {
  port,
  startAddonServer,
  stopAddonServer,
} from '@/electron/server/addon-server.js';

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

const loadedMarketplaces: AddonMarketplace[] = [];

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
    const parsedAddon = parseAddonLink(addon);
    let addonPath = '';
    if (parsedAddon.kind === 'local') {
      addonPath = parsedAddon.path;
    } else {
      addonPath = join(__dirname, 'addons', parsedAddon.addonName);
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
        return instance.startRegistered(parsedAddon.normalized);
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

export async function loadMarketplace(
  url: string,
  options?: { refresh?: boolean }
): Promise<AddonMarketplace> {
  const refresh = options?.refresh === true;
  let marketplace = loadedMarketplaces.find((m) => m.url === url);

  if (marketplace && refresh) {
    // fetch() keeps the last good catalog on failure; do not evict the cache.
    await marketplace.fetch();
    return marketplace;
  }

  if (!marketplace) {
    const newMarketplace = new AddonMarketplace(url);
    const ok = await newMarketplace.fetch();
    if (!ok) {
      // Do not cache a failed fetch; callers can retry on the next request.
      return newMarketplace;
    }
    console.log(
      `[addon-handler] Loaded marketplace from ${url}.`,
      newMarketplace.getAddons()
    );
    loadedMarketplaces.push(newMarketplace);
    marketplace = newMarketplace;
  }
  return marketplace;
}

export default function AddonManagerHandler(mainWindow: BrowserWindow) {
  ipcMain.handle('install-addons', async (_, addons: string[]) => {
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
          return;
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

    for (const addonUrlWithMarketplace of addons) {
      const parsedAddon = parseAddonLink(addonUrlWithMarketplace);
      const addonName = parsedAddon.addonName;
      const isLocal = parsedAddon.kind === 'local';
      const gitUrl =
        parsedAddon.kind === 'local' ? undefined : parsedAddon.gitUrl;
      let addonPath = join(__dirname, `addons/${addonName}`);
      if (parsedAddon.kind === 'local') {
        addonPath = parsedAddon.path;
      }
      let clonedThisInstall = false;

      try {
        if (fs.existsSync(join(addonPath, 'installation.log'))) {
          const alreadyRegistered = stagedUpdate.addons.includes(
            parsedAddon.normalized
          );
          if (!alreadyRegistered) {
            stagedUpdate.addons.push(parsedAddon.normalized);
            sendNotification({
              message: `Re-registered ${addonName} in addon config.`,
              id: Math.random().toString(36).substring(7),
              type: 'info',
            });
          } else {
            sendNotification({
              message: `Addon ${addonName} already installed and setup.`,
              id: Math.random().toString(36).substring(7),
              type: 'info',
            });
          }
          continue;
        }

        if (!isLocal && !fs.existsSync(join(addonPath, 'addon.json'))) {
          // Validate git URL/SSH pattern before cloning
          const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/;
          if (!gitUrl || !gitUrlPattern.test(gitUrl)) {
            sendNotification({
              message: `Invalid git URL format for addon ${addonName}`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
            continue;
          }

          const unloadedAddon = new Addon.Git({ path: addonPath });
          await unloadedAddon.clone(gitUrl);
          clonedThisInstall = true;

          if (parsedAddon.kind === 'marketplace') {
            const marketplace = await loadMarketplace(
              parsedAddon.marketplaceUrl
            );
            // now get the latest pinned commit hash and checkout to there
            const addonFromMarketplace = marketplace.getAddon(gitUrl);
            if (!addonFromMarketplace) {
              sendNotification({
                message: `Addon ${addonName} not found in marketplace.`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              if (clonedThisInstall && fs.existsSync(addonPath)) {
                fs.rmSync(addonPath, { recursive: true, force: true });
              }
              continue;
            }

            if (
              addonFromMarketplace.pinnedCommit &&
              addonFromMarketplace.pinnedCommit !== 'latest'
            )
              await unloadedAddon.checkoutCommit(
                addonFromMarketplace.pinnedCommit
              );
            else {
              console.log('Defaulting to latest commit.');
            }
          }
        }

        const instance = await Addon.load(addonPath);
        const hasAddonBeenSetup = instance ? await instance.install() : false;
        if (!hasAddonBeenSetup) {
          sendNotification({
            message: `An error occurred when setting up ${addonName}`,
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
          if (clonedThisInstall && fs.existsSync(addonPath)) {
            fs.rmSync(addonPath, { recursive: true, force: true });
          }
        } else {
          sendNotification({
            message: `Addon ${addonName} installed successfully.`,
            id: Math.random().toString(36).substring(7),
            type: 'success',
          });
          if (!stagedUpdate.addons.includes(parsedAddon.normalized)) {
            stagedUpdate.addons.push(parsedAddon.normalized);
          }
        }
      } catch (installErr) {
        console.error(`Failed to install addon ${addonName}:`, installErr);
        sendNotification({
          message: `An error occurred when installing ${addonName}`,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        if (clonedThisInstall && fs.existsSync(addonPath)) {
          // Clean up a partial clone so retries do not install from an unpinned default branch.
          fs.rmSync(addonPath, { recursive: true, force: true });
        }
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

  ipcMain.handle('clean-addons', async (_, marketplaceUrls: string[]) => {
    for (const instance of [...Addon.running.values()]) {
      console.log(`Stopping addon ${instance.config.path}`);
      instance.stop();
    }

    // delete specific addons in marketplaceUrls
    for (const addonURL of marketplaceUrls) {
      const parsedAddon = parseAddonLink(addonURL);
      let addonPath = '';
      if (parsedAddon.kind === 'local') {
        addonPath = parsedAddon.path;
      } else {
        addonPath = join(__dirname, 'addons', parsedAddon.addonName);
      }
      if (fs.existsSync(addonPath)) {
        fs.rmSync(addonPath, { recursive: true, force: true });
      }
    }

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
    const normalizedAddons = addons.map((addon) => normalizeAddonLink(addon));

    const updatePromises: Promise<void>[] = [];

    for (const addonWithMarketplace of normalizedAddons) {
      const parsedAddon = parseAddonLink(addonWithMarketplace);
      let addonPath = '';
      let marketplaceUrl =
        parsedAddon.kind === 'marketplace'
          ? parsedAddon.marketplaceUrl
          : parsedAddon.kind;
      let gitUrl =
        parsedAddon.kind === 'local' ? undefined : parsedAddon.gitUrl;
      let addonName = parsedAddon.addonName;

      if (parsedAddon.kind === 'local') {
        addonPath = parsedAddon.path;
      } else {
        addonPath = join(__dirname, 'addons', parsedAddon.addonName);
      }

      if (!isGitRepository(addonPath)) {
        console.log(
          `Skipping addon update for ${addonName}: ${addonPath} is not a valid git repository`
        );
        // Treat skipped non-git/corrupt addon installs as resolved so promise indexes stay aligned.
        updatePromises.push(Promise.resolve());
        continue;
      }

      if (parsedAddon.kind === 'local') {
        updatePromises.push(Promise.resolve());
        continue;
      }

      const updatePromise = new Promise<void>(async (resolve, reject) => {
        console.log(addonPath);
        const addonJSON = Addon.Setup.loadAddonConfig(addonPath);
        const addonSetup = new Addon.Setup({
          name: addonName,
          path: addonPath,
          scripts: addonJSON.scripts,
        });

        const fetchResult = await tryCatch(async () => {
          return {
            alreadyUpToDate: (await addonSetup.git.fetch()).alreadyUpToDate,
            currentHash: await addonSetup.git.getCurrentHash(),
          };
        });
        if (fetchResult.error) {
          sendNotification({
            message: `Failed to update addon ${addonName}`,
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
          reject(fetchResult.error);
          return;
        }
        const fetchData = fetchResult.data;
        console.log(marketplaceUrl, addonName, gitUrl);
        let alreadyUpToDate = fetchData.alreadyUpToDate;

        if (parsedAddon.kind === 'marketplace') {
          const marketplace = await loadMarketplace(
            parsedAddon.marketplaceUrl,
            {
              refresh: true,
            }
          );

          const marketplaceAddon = marketplace.getAddon(gitUrl!);
          if (!marketplaceAddon) {
            sendNotification({
              message: `Could not find ${addonName} in marketplace.`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
            reject(new Error(`Could not find ${addonName} in marketplace.`));
            return;
          }

          const pinnedCommit = marketplaceAddon.pinnedCommit ?? 'latest';
          alreadyUpToDate =
            pinnedCommit === 'latest'
              ? fetchData.alreadyUpToDate
              : fetchData.currentHash === pinnedCommit;
          if (alreadyUpToDate && (await addonSetup.isInstalled())) {
            sendNotification({
              message: `Addon ${addonName} is already up to date.`,
              id: Math.random().toString(36).substring(7),
              type: 'info',
            });
            mainWindow!!.webContents.send(
              'addon:updated',
              addonWithMarketplace
            );
            resolve();
            return;
          }

          if (pinnedCommit !== 'latest') {
            await addonSetup.git.checkoutCommit(pinnedCommit);
          } else if (!alreadyUpToDate) {
            await addonSetup.git.pull();
          }
        } else if (alreadyUpToDate && (await addonSetup.isInstalled())) {
          sendNotification({
            message: `Addon ${addonName} is already up to date.`,
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });
          mainWindow!!.webContents.send('addon:updated', addonWithMarketplace);
          resolve();
          return;
        } else {
          await addonSetup.git.pull();
        }

        if (alreadyUpToDate) {
          console.log(
            `Addon ${addonName} is already up to date, but installation.log is missing. Running setup.`
          );
        } else if (await addonSetup.isInstalled()) {
          // get rid of the installation log because not up-to-date
          fs.unlinkSync(join(addonPath, 'installation.log'));
        }

        void Addon.load(addonPath).then(async (instance) => {
          if (!instance) {
            reject(new Error(`Failed to load addon ${addonName}`));
            return;
          }
          try {
            const success = await instance.install();
            if (!success || !(await instance.setup.isInstalled())) {
              sendNotification({
                message: `An error occurred when setting up ${addonName}`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              reject(new Error(`Failed to setup addon ${addonName}`));
              return;
            }

            sendNotification({
              message: alreadyUpToDate
                ? `Addon ${addonName} setup completed successfully.`
                : `Addon ${addonName} updated successfully.`,
              id: Math.random().toString(36).substring(7),
              type: 'info',
            });
            mainWindow!!.webContents.send(
              'addon:updated',
              addonWithMarketplace
            );
            console.log(`Addon ${addonName} updated and setup successfully.`);
            resolve();
          } catch (setupErr) {
            sendNotification({
              message: `An error occurred when setting up ${addonName}`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
            reject(setupErr);
          }
        });
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

        sendNotification({
          message: `Failed to update addon ${addons[index]} with reason ${result.reason}`,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
      }
    });

    if (failedCount > 0) {
      console.log(`${failedCount} addons failed to update.`);
    }

    if (failedCount === addons.length) {
      sendNotification({
        message: 'All addons failed to update.',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      return;
    }

    // restart all of the addons
    await restartAddonServer();

    if (failedCount === 0) {
      sendNotification({
        message: 'Successfully updated addons.',
        id: Math.random().toString(36).substring(7),
        type: 'info',
      });
    } else {
      sendNotification({
        message: `Updated addons with ${failedCount} failure${failedCount === 1 ? '' : 's'}.`,
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
    }
  });
}
