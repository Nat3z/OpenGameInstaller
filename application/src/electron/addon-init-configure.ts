import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendNotification } from './main.js';
import z from 'zod';
import exec from 'child_process';
import { addonSecret } from './server/constants.js';
import { clients } from './server/addon-server.js';

export let processes: {
  [key: string]: exec.ChildProcess;
} = {};

export const AddonFileConfigurationSchema = z.object({
  author: z.string(),
  scripts: z.object({
    setup: z.string().optional(),
    run: z.string(),
    preSetup: z.string().optional(),
    postSetup: z.string().optional(),
  }),
});

function stripAnsiCodes(input: string): string {
  // Regular expression to match ANSI escape codes
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return input.replace(ansiRegex, '');
}
export async function setupAddon(addonPath: string): Promise<boolean> {
  const addonConfig = await readFile(join(addonPath, 'addon.json'), 'utf-8');
  const addonName = addonPath.split(/\/|\\/).pop();
  if (!addonConfig) {
    sendNotification({
      type: 'error',
      message:
        'Addon configuration not found for ' + addonPath.split('/').pop(),
      id: Math.random().toString(36).substring(7),
    });
    return false;
  }
  const addonJSON: any = JSON.parse(addonConfig);
  const addon = AddonFileConfigurationSchema.parse(addonJSON);

  let setupLogs = '';
  sendNotification({
    type: 'info',
    message: 'Setting up ' + addonName,
    id: Math.random().toString(36).substring(7),
  });
  if (addon.scripts.preSetup) {
    try {
      setupLogs += `
Running pre-setup script for ${addonName}...
> ${addon.scripts.preSetup}
      `;
      setupLogs += await executeScript(
        'pre-setup',
        addon.scripts.preSetup,
        addonPath
      );
    } catch (e) {
      sendNotification({
        type: 'error',
        message: 'Error running pre-setup script for ' + addonName,
        id: Math.random().toString(36).substring(7),
      });
      return false;
    }
  }

  if (addon.scripts.setup) {
    try {
      setupLogs += `
Running setup script for ${addonName}...
> ${addon.scripts.setup}
      `;
      await executeScript('setup', addon.scripts.setup, addonPath);
    } catch (e) {
      sendNotification({
        type: 'error',
        message: 'Error running setup script for ' + addonName,
        id: Math.random().toString(36).substring(7),
      });
      return false;
    }
  }

  if (addon.scripts.postSetup) {
    try {
      setupLogs += `
Running post-setup script for ${addonName}...
> ${addon.scripts.postSetup}
      `;
      await executeScript('post-setup', addon.scripts.postSetup, addonPath);
    } catch (e) {
      sendNotification({
        type: 'error',
        message: 'Error running post-setup script for ' + addonName,
        id: Math.random().toString(36).substring(7),
      });
      return false;
    }
  }

  await writeFile(
    join(addonPath, 'installation.log'),
    stripAnsiCodes(setupLogs)
  );
  return true;
}

export async function startAddon(addonPath: string, addonLink: string) {
  const addonConfig = await readFile(join(addonPath, 'addon.json'), 'utf-8');
  // remove any trailing slashes
  addonPath = addonPath.replace(/\/$/, '');
  const addonName = addonPath.split('/').pop();
  if (!addonConfig) {
    sendNotification({
      type: 'error',
      message: 'Addon configuration not found for ' + addonName,
      id: Math.random().toString(36).substring(7),
    });
    return;
  }
  const addonJSON: any = JSON.parse(addonConfig);
  const addon = AddonFileConfigurationSchema.parse(addonJSON);
  try {
    executeScript(
      'run',
      addon.scripts.run + ' --addonSecret="' + addonSecret + '"',
      addonPath
    );
    let attempts = 0;
    await new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (attempts > 10) {
          clearInterval(interval);
          reject(new Error('Addon not found'));
          return;
        }

        if (clients.has(addonName!)) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        attempts++;
      }, 500);
    });
    let client = clients.get(addonName!);
    if (client) {
      client.filePath = addonPath;
      client.addonLink = addonLink;
      console.log(
        'Registered addon identifier path for ' +
          addonName +
          ' to ' +
          addonPath +
          ' with link ' +
          addonLink
      );
    }
  } catch (e) {
    console.error(e);

    // write to the run-crash.log file
    await writeFile(
      join(addonPath, 'run-crash.log'),
      stripAnsiCodes(e.message)
    );

    sendNotification({
      type: 'error',
      message: 'Error running run script for ' + addonPath.split('/').pop(),
      id: Math.random().toString(36).substring(7),
    });
  }
}

async function executeScript(
  scriptName: string,
  script: string,
  addonPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    processes[addonPath] = exec.exec(
      script,
      {
        cwd: addonPath,
      },
      (err, stdout, stderr) => {
        if (err) {
          // write the error to a log file
          writeFile(
            join(addonPath, scriptName + '-crash.log'),
            stripAnsiCodes(stderr)
          );
          reject(err);
          return;
        }
        resolve(stdout);
      }
    );
  });
}
