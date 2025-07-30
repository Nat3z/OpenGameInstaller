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
  const addonName = addonPath.split(/\/|\\/).pop() ?? 'unknown-addon';
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
        addonPath,
        addonName
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
      await executeScript('setup', addon.scripts.setup, addonPath, addonName);
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
      await executeScript(
        'post-setup',
        addon.scripts.postSetup,
        addonPath,
        addonName
      );
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
  const addonName =
    addonPath.replace(/\/$/, '').split(/\/|\\/).pop() ?? 'unknown-addon';
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
      addon.scripts.run + ' --addonSecret=' + addonSecret,
      addonPath,
      addonName
    );
    let attempts = 0;
    const success = await new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        if (attempts > 10) {
          clearInterval(interval);
          console.error(
            'Addon ' +
              addonName +
              ' not found in clients. Cannot attach path nor link.'
          );
          resolve(false);
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
    if (!success) {
      return;
    }
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
  addonPath: string,
  addonName: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let bunPath = '';
    // if on windows, then use C:\Users\username\.bun\bin\bun.exe
    // if on linux, then use ~/.bun/bin/bun
    if (process.platform === 'win32') {
      if (!process.env.USERPROFILE) {
        sendNotification({
          message: 'USERPROFILE is not set. Cannot run scripts.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        return reject();
      }
      bunPath = join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe');
    } else {
      if (!process.env.HOME) {
        sendNotification({
          message: 'HOME is not set. Cannot run scripts.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        return reject();
      }
      bunPath = join(process.env.HOME || '', '.bun', 'bin', 'bun');
    }
    // Properly use spawn (no callback, returns ChildProcess)
    const [cmd, ...args] = script.replace(/^bun/, bunPath).split(' ');
    console.log('cmd', cmd);
    console.log('args', args);
    const child = exec.spawn(cmd, args, {
      cwd: addonPath,
      shell: process.platform === 'win32', // for Windows compatibility
    });

    let stdout = '';
    let stderr = '';

    processes[addonPath] = child;

    child.stdout?.on('data', (data: Buffer) => {
      console.log('[' + addonName + '@' + scriptName + '] ' + data.toString());
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(
        '[' + addonName + '@' + scriptName + '] ' + data.toString()
      );
      stderr += data.toString();
    });

    child.on('close', (code: number) => {
      if (code !== 0) {
        // write the error to a log file
        console.error(
          '[' + addonName + '@' + scriptName + '] Exited with error: ' + code
        );
        reject(new Error('Addon ' + addonName + ' exited with error: ' + code));
        return;
      }
      resolve(stdout);
    });

    child.on('error', (err: Error) => {
      console.error(err);
      reject(err);
    });
  });
}
