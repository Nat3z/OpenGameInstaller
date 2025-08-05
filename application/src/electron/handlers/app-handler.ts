import axios from 'axios';
import { net, ipcMain } from 'electron';
import { currentScreens, sendIPCMessage, sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { LibraryInfo } from 'ogi-addon';
import { __dirname } from '../paths.js';
import { STEAMTINKERLAUNCH_PATH } from '../startup.js';
import { clients } from '../server/addon-server.js';
import { dirname, basename } from 'path';

const getSilentInstallFlags = (
  filePath: string,
  fileName: string
): string[] => {
  const lowerFileName = fileName.toLowerCase();
  const lowerFilePath = filePath.toLowerCase();

  // Microsoft Visual C++ Redistributables
  if (
    lowerFileName.includes('vcredist') ||
    lowerFileName.includes('vc_redist')
  ) {
    return ['/S', '/v/qn']; // /S for silent, /v/qn for very quiet
  }

  // DirectX redistributables
  if (
    lowerFileName.includes('directx') ||
    lowerFileName.includes('dxwebsetup')
  ) {
    return ['/S'];
  }

  // .NET Framework redistributables
  if (lowerFileName.includes('dotnet') || lowerFileName.includes('netfx')) {
    return ['/S', '/v/qn'];
  }

  // MSI installers
  if (lowerFileName.endsWith('.msi')) {
    return ['/S', '/qn']; // /qn = quiet no UI
  }

  // NSIS installers
  if (lowerFilePath.includes('nsis') || lowerFileName.includes('setup')) {
    return ['/S'];
  }

  // Inno Setup installers
  if (lowerFileName.includes('inno')) {
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  }

  // InstallShield installers
  if (lowerFileName.includes('installshield')) {
    return ['/S', '/v/qn'];
  }

  // Default fallback - try multiple common flags
  return ['/S'];
};

const installRedistributablesWithSystemWine = async (
  redistributables: { name: string; path: string }[],
  winePrefix: string,
  gameName: string
) => {
  for (const redistributable of redistributables) {
    try {
      sendNotification({
        message: `Installing ${redistributable.name} for ${gameName} (using system Wine)`,
        id: Math.random().toString(36).substring(7),
        type: 'info',
      });

      console.log(
        `[redistributable] Installing ${redistributable.name} with system wine`
      );

      const success = await new Promise<boolean>((resolve) => {
        const redistributablePath = redistributable.path
          .trim()
          .replace(/\n$/g, '');
        const redistributableDir = dirname(redistributablePath);

        // Get appropriate silent installation flags
        const redistributableFilename = basename(redistributablePath);
        const silentFlags = getSilentInstallFlags(
          redistributablePath,
          redistributableFilename
        );
        const args = [redistributablePath, ...silentFlags];

        console.log(
          `[redistributable] Using silent flags: ${silentFlags.join(' ')} for ${redistributableFilename}`
        );

        const child = spawn('wine', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: redistributableDir,
          env: {
            ...process.env,
            WINEPREFIX: winePrefix,
            WINEDEBUG: '-all', // Reduce wine debug output
            DISPLAY: ':0', // Ensure we have a display for wine
            WINEDLLOVERRIDES: 'mscoree,mshtml=', // Disable .NET and HTML rendering for faster installs
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
          const output = data.toString();
          stdout += output;
          console.log(`[redistributable:stdout] ${output.trim()}`);
        });

        child.stderr?.on('data', (data) => {
          const output = data.toString();
          stderr += output;
          console.log(`[redistributable:stderr] ${output.trim()}`);
        });

        child.on('close', (code) => {
          console.log(
            `[redistributable] system wine process exited with code ${code}`
          );
          if (code === 0) {
            resolve(true);
          } else {
            console.error(
              `[redistributable] Installation failed with exit code ${code}`
            );
            console.error(`[redistributable] stdout: ${stdout}`);
            console.error(`[redistributable] stderr: ${stderr}`);
            resolve(false);
          }
        });

        child.on('error', (error) => {
          console.error(
            `[redistributable] failed to start system wine process: ${error}`
          );
          resolve(false);
        });

        // Set a timeout for the installation (5 minutes for silent installs)
        setTimeout(
          () => {
            console.error(
              `[redistributable] System wine installation timed out after 5 minutes`
            );
            child.kill('SIGTERM');
            setTimeout(() => {
              child.kill('SIGKILL'); // Force kill if SIGTERM doesn't work
            }, 5000);
            resolve(false);
          },
          5 * 60 * 1000
        );
      });

      if (success) {
        sendNotification({
          message: `Installed ${redistributable.name} for ${gameName}`,
          id: Math.random().toString(36).substring(7),
          type: 'success',
        });
      } else {
        sendNotification({
          message: `Failed to install ${redistributable.name} for ${gameName}`,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
      }
    } catch (error) {
      console.error(
        `[redistributable] Error installing ${redistributable.name}: ${error}`
      );
      sendNotification({
        message: `Failed to install ${redistributable.name} for ${gameName}`,
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
    }
  }
};
export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('app:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('app:axios', async (_, options) => {
    if (
      options.data &&
      options.headers &&
      options.headers['Content-Type'] === 'multipart/form-data'
    ) {
      const formData = new FormData();
      for (const [key, value] of Object.entries(options.data)) {
        formData.append(key, value as string);
      }
      options.data = formData;
    }
    console.log('app:axios', options);
    try {
      const response = await axios(options);
      return {
        data: response.data,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
      };
    } catch (err) {
      return {
        data: err.response.data,
        status: err.response.status,
        success: false,
      };
    }
  });

  ipcMain.handle('app:get-os', () => {
    return process.platform;
  });
  ipcMain.handle('app:screen-input', async (_, data) => {
    currentScreens.set(data.id, data.data);
    return;
  });

  ipcMain.handle('app:is-online', async () => {
    return net.isOnline();
  });
  ipcMain.handle('app:launch-game', async (_, appid) => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return;
    }
    if (!fs.existsSync(join(__dirname, 'internals'))) {
      fs.mkdirSync(join(__dirname, 'internals'));
    }
    if (!fs.existsSync(join(__dirname, 'library/' + appid + '.json'))) {
      return;
    }

    const appInfo: LibraryInfo = JSON.parse(
      fs.readFileSync(join(__dirname, 'library/' + appid + '.json'), 'utf-8')
    );
    let args = appInfo.launchArguments || '%command%';
    // replace %command% with the launch executable
    args = args.replace('%command%', `"${appInfo.launchExecutable}"`);
    console.log('Launching game with args: ' + args, 'in cwd: ' + appInfo.cwd);
    const spawnedItem = exec(args, {
      cwd: appInfo.cwd,
    });
    spawnedItem.on('error', (error) => {
      console.error(error);
      sendNotification({
        message: 'Failed to launch game',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      console.error('Failed to launch game');
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });
    spawnedItem.on('exit', (exit) => {
      console.log('Game exited with code: ' + exit);
      if (exit !== 0) {
        sendNotification({
          message: 'Game Crashed',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });

        mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
        return;
      }

      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });

    mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
  });

  ipcMain.handle('app:remove-app', async (_, appid: number) => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return;
    }
    if (!fs.existsSync(join(__dirname, 'internals'))) {
      fs.mkdirSync(join(__dirname, 'internals'));
    }
    if (!fs.existsSync(join(__dirname, 'library/' + appid + '.json'))) {
      return;
    }
    fs.unlinkSync(join(__dirname, 'library/' + appid + '.json'));
    const appsInternal = JSON.parse(
      fs.readFileSync(join(__dirname, 'internals/apps.json'), 'utf-8')
    );
    const index = appsInternal.indexOf(appid);
    if (index > -1) {
      appsInternal.splice(index, 1);
    }
    fs.writeFileSync(
      join(__dirname, 'internals/apps.json'),
      JSON.stringify(appsInternal, null, 2)
    );
    return;
  });

  ipcMain.handle(
    'app:insert-app',
    async (
      _,
      data: LibraryInfo & {
        redistributables?: { name: string; path: string }[];
      }
    ): Promise<
      | 'setup-failed'
      | 'setup-success'
      | 'setup-redistributables-failed'
      | 'setup-redistributables-success'
    > => {
      if (!fs.existsSync(join(__dirname, 'library')))
        fs.mkdirSync(join(__dirname, 'library'));

      const appPath = join(__dirname, `library/${data.appID}.json`);
      fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
      if (!fs.existsSync(join(__dirname, 'internals'))) {
        fs.mkdirSync(join(__dirname, 'internals'));
      }
      // write to the internal file
      if (!fs.existsSync(join(__dirname, 'internals/apps.json'))) {
        fs.writeFileSync(
          join(__dirname, 'internals/apps.json'),
          JSON.stringify([], null, 2)
        );
      }
      const appsInternal = JSON.parse(
        fs.readFileSync(join(__dirname, 'internals/apps.json'), 'utf-8')
      );

      appsInternal.push(data.appID);
      fs.writeFileSync(
        join(__dirname, 'internals/apps.json'),
        JSON.stringify(appsInternal, null, 2)
      );

      if (process.platform === 'linux') {
        // make the launch executable use / instead of \
        data.launchExecutable = data.launchExecutable.replaceAll('\\', '/');
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const protonPath = `${homeDir}/.ogi-wine-prefixes/${data.appID}/pfx`;
        // if the proton path does not exist, create it
        if (!fs.existsSync(protonPath)) {
          fs.mkdirSync(protonPath, { recursive: true });
        }

        // if there are redistributables, we need to install them
        if (data.redistributables) {
          // First check if wine is available via flatpak
          const wineAvailable = await new Promise<boolean>((resolve) => {
            exec('flatpak run org.winehq.Wine --help', (err) => {
              resolve(!err);
            });
          });

          if (!wineAvailable) {
            // Try alternative wine installation methods
            const alternativeWineAvailable = await new Promise<boolean>(
              (resolve) => {
                exec('wine --version', (err) => {
                  if (!err) {
                    console.log(
                      '[redistributable] Found system wine installation'
                    );
                    resolve(true);
                  } else {
                    // Check for wine in common paths
                    exec('which wine', (err2) => {
                      resolve(!err2);
                    });
                  }
                });
              }
            );

            if (alternativeWineAvailable) {
              console.log('[redistributable] Using system wine installation');
              await installRedistributablesWithSystemWine(
                data.redistributables,
                protonPath,
                data.name
              );
            } else {
              sendNotification({
                message:
                  'Wine is not available. Redistributables will be skipped. Please install Wine via Flatpak or your system package manager.',
                id: Math.random().toString(36).substring(7),
                type: 'warning',
              });
              console.warn(
                '[redistributable] Wine not available, skipping redistributables'
              );
            }
          } else {
            let rootPassword = '';
            // firstly, allow the flatpak to access the proton path
            const rootPasswordGranter = () =>
              new Promise<void>((resolve) => {
                sendIPCMessage('app:ask-root-password', true);
                ipcMain.handleOnce(
                  'app:root-password-granted',
                  async (_, password) => {
                    // allow the flatpak to access the proton path
                    try {
                      execSync(`echo -e "${password}\n" | sudo -S -k true`, {
                        stdio: 'ignore',
                      });
                      // await grantAccessToPath(protonPath, password);
                      rootPassword = password;
                      resolve();
                    } catch (error) {
                      console.error(error);
                      sendNotification({
                        message:
                          'Failed to allow flatpak to access the proton path.',
                        id: Math.random().toString(36).substring(7),
                        type: 'error',
                      });
                      await rootPasswordGranter();
                      resolve();
                    }
                  }
                );
              });
            await rootPasswordGranter();

            // firstly run wineboot to update the wine prefix
            const wineboot = new Promise<void>((resolve) => {
              const wineboot = spawn(
                'flatpak',
                [
                  `--env="WINEPREFIX=${protonPath}"`,
                  '--filesystem=host',
                  '--command=wineboot',
                  'run',
                  'org.winehq.Wine',
                ],
                {
                  stdio: ['inherit', 'pipe', 'pipe'],
                  cwd: __dirname,
                }
              );
              wineboot.on('close', (code) => {
                if (code === 0) {
                  resolve();
                } else {
                  resolve();
                }
              });
              wineboot.on('error', (error) => {
                console.error(error);
                resolve();
              });
              wineboot.stdout?.on('data', (data) => {
                console.log(`[wineboot:stdout] ${data.toString()}`);
              });
              wineboot.stderr?.on('data', (data) => {
                console.log(`[wineboot:stderr] ${data.toString()}`);
              });
            });

            // activate wineboot
            await wineboot;

            for (const redistributable of data.redistributables) {
              try {
                sendNotification({
                  message: `Installing ${redistributable.name} for ${data.name}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'info',
                });

                console.log('Running redistributable: ' + redistributable.path);

                const success = await new Promise<boolean>(async (resolve) => {
                  if (redistributable.path === 'winetricks') {
                    console.log('spawning winetricks redistributable');
                    // spawn winetricks with the proton path to install the name
                    // For winetricks to show the installation UI, we need to ensure DISPLAY is set and not use --unattended or -q.
                    // Also, do not quote the env var assignment for flatpak (should be --env=VAR=VAL, not --env="VAR=VAL")
                    // Note: If interactive mode fails, consider adding --unattended as a fallback
                    const child = spawn(
                      'flatpak',
                      [
                        `--env="WINEPREFIX=${protonPath}"`,
                        `--env=DISPLAY=:0`, // Ensure display for wine UI
                        `--env=WINEDEBUG=-all`, // Reduce wine debug output
                        `--env=WINEDLLOVERRIDES=mscoree,mshtml=`, // Disable .NET and HTML rendering
                        '--filesystem=host',
                        '--command=winetricks',
                        'run',
                        'org.winehq.Wine',
                        `${redistributable.name}`,
                        '--force',
                        // Do NOT use '--unattended' or '-q' so the UI is shown
                      ],
                      {
                        stdio: ['inherit', 'pipe', 'pipe'], // Changed from 'ignore' to 'inherit' to allow interactive input
                        cwd: __dirname,
                      }
                    );
                    let stdout = '';
                    let stderr = '';

                    child.on('close', (code) => {
                      console.log(
                        `[winetricks] process exited with code ${code}`
                      );
                      if (code === 0) {
                        console.log(
                          '[winetricks] Installation completed successfully'
                        );
                        resolve(true);
                      } else {
                        console.error(
                          `[winetricks] Installation failed with exit code ${code}`
                        );
                        console.error(`[winetricks] stdout: ${stdout}`);
                        console.error(`[winetricks] stderr: ${stderr}`);
                        resolve(false);
                      }
                    });
                    child.on('error', (error) => {
                      console.error('[winetricks] Process error:', error);
                      console.error(`[winetricks] stdout: ${stdout}`);
                      console.error(`[winetricks] stderr: ${stderr}`);
                      resolve(false);
                    });
                    child.stdout?.on('data', (data) => {
                      const output = data.toString();
                      stdout += output;
                      console.log(`[winetricks:stdout] ${output.trim()}`);
                    });
                    child.stderr?.on('data', (data) => {
                      const output = data.toString();
                      stderr += output;
                      console.log(`[winetricks:stderr] ${output.trim()}`);
                    });
                    return;
                  }

                  const redistributablePath = redistributable.path
                    .trim()
                    .replace(/\n$/g, '');
                  const redistributableDir = dirname(redistributablePath);
                  const redistributableFilename = basename(redistributablePath);

                  // Get appropriate silent installation flags
                  const silentFlags = getSilentInstallFlags(
                    redistributablePath,
                    redistributableFilename
                  );
                  const redistributableArgs = [
                    redistributableFilename,
                    ...silentFlags,
                  ];

                  console.log(
                    `[redistributable] Using silent flags: ${silentFlags.join(' ')} for ${redistributableFilename}`
                  );

                  const command = 'flatpak';
                  const args = [
                    `--env="WINEPREFIX=${protonPath}"`,
                    `--env=DISPLAY=:0`, // Ensure display for wine
                    `--env=WINEDEBUG=-all`, // Reduce wine debug output
                    `--env=WINEDLLOVERRIDES=mscoree,mshtml=`, // Disable .NET and HTML rendering
                    '--filesystem=host',
                    'run',
                    'org.winehq.Wine',
                    ...redistributableArgs,
                  ];

                  console.log(
                    `[redistributable] Executing: ${command} ${args.join(' ')}`
                  );
                  console.log(
                    `[redistributable] Working directory: ${redistributableDir}`
                  );

                  const child = spawn(command, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    cwd: redistributableDir,
                  });

                  let stdout = '';
                  let stderr = '';

                  child.stdout?.on('data', (data) => {
                    const output = data.toString();
                    stdout += output;
                    console.log(`[redistributable:stdout] ${output.trim()}`);
                  });

                  child.stderr?.on('data', (data) => {
                    const output = data.toString();
                    stderr += output;
                    console.log(`[redistributable:stderr] ${output.trim()}`);
                  });

                  child.on('close', (code) => {
                    console.log(
                      `[redistributable] process exited with code ${code}`
                    );
                    if (code === 0) {
                      resolve(true);
                    } else {
                      console.error(
                        `[redistributable] Installation failed with exit code ${code}`
                      );
                      console.error(`[redistributable] stdout: ${stdout}`);
                      console.error(`[redistributable] stderr: ${stderr}`);
                      resolve(false);
                    }
                  });

                  child.on('error', (error) => {
                    console.error(
                      `[redistributable] failed to start process: ${error}`
                    );
                    resolve(false);
                  });

                  // Set a timeout for the installation (10 minutes for silent installs)
                  setTimeout(
                    () => {
                      // check if the process is still running
                      if (child.pid) {
                        child.kill('SIGTERM');
                        setTimeout(() => {
                          child.kill('SIGKILL'); // Force kill if SIGTERM doesn't work
                        }, 5000);
                      }
                      console.error(
                        `[redistributable] Flatpak wine installation timed out after 10 minutes`
                      );
                      resolve(false);
                    },
                    10 * 60 * 1000
                  );
                });

                if (!success) {
                  throw new Error(`Failed to install ${redistributable.name}`);
                }

                sendNotification({
                  message: `Installed ${redistributable.name} for ${data.name}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'success',
                });
              } catch (error) {
                console.error(
                  `[redistributable] failed to install ${redistributable.name} for ${data.name}: ${error}`
                );
                sendNotification({
                  message: `Failed to install ${redistributable.name} for ${data.name}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
              }
            }
            sendNotification({
              message: `Installed redistributables for ${data.name}`,
              id: Math.random().toString(36).substring(7),
              type: 'success',
            });
          }
        }

        // use steamtinkerlaunch to add the game to steam
        const result = await new Promise<boolean>((resolve) =>
          exec(
            `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${data.name}" --exepath="${data.launchExecutable}" --startdir="${data.cwd}" --launchoptions="STEAM_COMPAT_DATA_PATH=${protonPath.split('/pfx')[0]} ${data.launchArguments ?? ''}" --compatibilitytool="proton_experimental" --use-steamgriddb`,
            {
              cwd: __dirname,
            },
            (error, stdout, stderr) => {
              if (error) {
                console.error(error);
                sendNotification({
                  message: 'Failed to add game to Steam',
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                resolve(false);
                return;
              }
              console.log(stdout);
              console.log(stderr);
              sendNotification({
                message: 'Game added to Steam',
                id: Math.random().toString(36).substring(7),
                type: 'success',
              });
              resolve(true);
            }
          )
        );
        if (!result) {
          return 'setup-redistributables-failed';
        }
      } else if (process.platform === 'win32') {
        // if there are redistributables, we need to install them
        if (data.redistributables) {
          for (const redistributable of data.redistributables) {
            try {
              spawnSync(redistributable.path, {
                stdio: 'inherit',
                shell: true,
              });
              sendNotification({
                message: `Installed ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'success',
              });
            } catch (error) {
              console.error(
                `[redistributable] failed to install ${redistributable.name} for ${data.name}: ${error}`
              );
            }
          }
        }
      }
      return 'setup-success';
    }
  );
  ipcMain.handle('app:get-all-apps', async () => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return [];
    }
    const files = fs.readdirSync(join(__dirname, 'library'));
    const apps: LibraryInfo[] = [];
    for (const file of files) {
      const data = fs.readFileSync(join(__dirname, `library/${file}`), 'utf-8');
      apps.push(JSON.parse(data));
    }
    return apps;
  });
  ipcMain.handle('app:get-addon-path', async (_, addonID: string) => {
    let client = clients.get(addonID);
    if (!client || !client.filePath) {
      return null;
    }
    return client.filePath;
  });
  ipcMain.handle('app:get-addon-icon', async (_, addonID: string) => {
    let client = clients.get(addonID);
    if (!client || !client.filePath) {
      return null;
    }
    // read the addon.json file to get the icon path
    const addonJson = JSON.parse(
      fs.readFileSync(join(client.filePath, 'addon.json'), 'utf-8')
    );
    if (!addonJson.icon) {
      return null;
    }
    const iconPath = join(client.filePath, addonJson.icon);
    if (!fs.existsSync(iconPath)) {
      console.error(
        'No icon path found for addon (does not exist): ' +
          addonID +
          ' at path: ' +
          iconPath
      );
      return null;
    }
    return iconPath;
  });
  ipcMain.handle('app:get-local-image', async (_, path: string) => {
    if (!fs.existsSync(path)) {
      return null;
    }
    const ext = path.split('.').pop()?.toLowerCase() || 'png';

    const mimeType =
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
      }[ext] || 'image/png';
    try {
      const buffer = fs.readFileSync(path);
      const base64 = buffer.toString('base64');
      return `data:${mimeType};base64,${base64}`;
    } catch (err) {
      console.error('Failed to read image file: ' + path);
      return null;
    }
  });
}
