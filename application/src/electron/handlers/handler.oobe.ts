import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { __dirname } from '../manager/manager.paths.js';
import fs from 'fs';
import { join } from 'path';
import axios from 'axios';
import { sendNotification, sendIPCMessage } from '../main.js';
import { IS_NIXOS, STEAMTINKERLAUNCH_PATH } from '../startup.js';
import os from 'os';

function sendOOBELog(content: string) {
  sendIPCMessage('oobe:log', content);
  console.log('[oobe]' + content);
}

export default function OOBEHandler() {
  const sevenZipDownload = 'https://7-zip.org/a/7z2407-x64.exe';

  ipcMain.handle('oobe:download-tools', async (_) => {
    // check if 7zip is installed
    let cleanlyDownloadedAll = true;
    let sevenZipPath = '';
    let requireRestart = false;
    if (process.platform === 'win32') {
      sevenZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
      const sevenZipInstalled = await new Promise<boolean>((resolve, _) => {
        exec(sevenZipPath + ' --help', (err, stdout, _) => {
          if (err) {
            resolve(false);
          }
          sendOOBELog(stdout);
          resolve(true);
        });
      });
      if (!sevenZipInstalled) {
        await new Promise<void>((resolve, reject) =>
          axios({
            method: 'get',
            url: sevenZipDownload,
            responseType: 'stream',
          })
            .then((response) => {
              const fileStream = fs.createWriteStream(
                join(__dirname, '7z-install.exe')
              );
              response.data.pipe(fileStream);
              fileStream.on('finish', async () => {
                sendOOBELog('Downloaded 7zip');
                fileStream.close();
                exec(
                  '7z-install.exe /S /D="C:\\Program Files\\7-Zip"',
                  (err, stdout, stderr) => {
                    if (err) {
                      sendOOBELog(`Error: ${err}`);
                      sendNotification({
                        message:
                          'Failed to install 7zip. Please allow the installer to run as administrator.',
                        id: Math.random().toString(36).substring(7),
                        type: 'error',
                      });
                      cleanlyDownloadedAll = false;
                      reject();
                      return;
                    }
                    sendOOBELog(stdout);
                    sendOOBELog(stderr);
                    fs.unlinkSync(join(__dirname, '7z-install.exe'));
                    sendNotification({
                      message: 'Successfully installed 7zip.',
                      id: Math.random().toString(36).substring(7),
                      type: 'info',
                    });
                    requireRestart = true;
                    resolve();
                  }
                );
              });

              fileStream.on('error', (err) => {
                sendOOBELog(`Error: ${err}`);
                fileStream.close();
                fs.unlinkSync(join(__dirname, '7z-install.exe'));
                cleanlyDownloadedAll = false;
              });
            })
            .catch((err) => {
              sendOOBELog(`Error: ${err}`);
            })
        );
      }
    }

    // check if git is installed
    const gitInstalled = await new Promise<boolean>((resolve, _) => {
      exec('git --version', (err, stdout, _) => {
        if (err) {
          resolve(false);
        }
        sendOOBELog(stdout);
        resolve(true);
      });
    });
    if (!gitInstalled) {
      if (process.platform === 'win32') {
        sendNotification({
          message: 'Git is not installed. Downloading git now.',
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
        const gitDownload =
          'https://github.com/git-for-windows/git/releases/download/v2.46.0.windows.1/Git-2.46.0-64-bit.exe';
        await new Promise<void>((resolve, reject) =>
          axios({
            method: 'get',
            url: gitDownload,
            responseType: 'stream',
          })
            .then((response) => {
              const fileStream = fs.createWriteStream(
                join(__dirname, 'git-install.exe')
              );
              response.data.pipe(fileStream);
              fileStream.on('finish', async () => {
                sendOOBELog('Downloaded git');
                fileStream.close();

                fs.writeFileSync(
                  'git_options.ini',
                  `
    [Setup]
    Lang=default
    Dir=C:\\Program Files\\Git
    Group=Git
    NoIcons=0
    SetupType=default
    Components=gitlfs,assoc,assoc_sh,windowsterminal
    Tasks=
    EditorOption=VIM
    CustomEditorPath=
    DefaultBranchOption=main
    PathOption=Cmd
    SSHOption=OpenSSH
    TortoiseOption=false
    CURLOption=WinSSL
    CRLFOption=CRLFCommitAsIs
    BashTerminalOption=MinTTY
    GitPullBehaviorOption=Merge
    UseCredentialManager=Enabled
    PerformanceTweaksFSCache=Enabled
    EnableSymlinks=Disabled
    EnablePseudoConsoleSupport=Disabled
    EnableFSMonitor=Disabled
                            `
                );
                exec(
                  'git-install.exe /VERYSILENT /NORESTART /NOCANCEL /LOADINF=git_options.ini',
                  (err, stdout, stderr) => {
                    if (err) {
                      sendOOBELog(`Error: ${err}`);
                      reject();
                      cleanlyDownloadedAll = false;
                      return;
                    }
                    sendOOBELog(stdout);
                    sendOOBELog(stderr);
                    fs.unlinkSync(join(__dirname, 'git-install.exe'));
                    sendNotification({
                      message: 'Successfully installed git.',
                      id: Math.random().toString(36).substring(7),
                      type: 'info',
                    });
                    requireRestart = true;
                    resolve();
                  }
                );
              });

              fileStream.on('error', (err) => {
                sendOOBELog(`Error: ${err}`);
                fileStream.close();
                fs.unlinkSync(join(__dirname, 'git-install.exe'));
              });
            })
            .catch((err) => {
              sendOOBELog(`Error: ${err}`);
            })
        );
      } else {
        sendNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Missing Git and auto-install is not supported for linux.',
          type: 'error',
        });
      }
    }

    // check if steamtinkerlaunch is installed
    if (
      process.platform === 'linux' &&
      STEAMTINKERLAUNCH_PATH ===
        join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch')
    ) {
      if (
        !fs.existsSync(
          join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch')
        )
      ) {
        await new Promise<void>((resolve, reject) => {
          exec(
            'git clone https://github.com/sonic2kk/steamtinkerlaunch ' +
              join(__dirname, 'bin/steamtinkerlaunch'),
            (err, stdout, stderr) => {
              if (err) {
                sendOOBELog(`Error: ${err}`);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              sendOOBELog(stdout);
              sendOOBELog(stderr);
              // run chmod +x on the file
              exec(
                'chmod +x ' +
                  join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                (err) => {
                  if (err) {
                    sendOOBELog(`Error: ${err}`);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }

                  // now executing steamtinkerlaunch
                  exec(
                    join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                    (err, stdout, stderr) => {
                      if (err) {
                        sendOOBELog(`Error: ${err}`);
                        reject();
                        cleanlyDownloadedAll = false;
                        return;
                      }
                      sendOOBELog(stdout);
                      sendOOBELog(stderr);
                      sendNotification({
                        message: 'Successfully installed steamtinkerlaunch.',
                        id: Math.random().toString(36).substring(7),
                        type: 'info',
                      });
                      resolve();
                    }
                  );
                }
              );
            }
          );
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          exec(
            'git pull',
            { cwd: join(__dirname, 'bin/steamtinkerlaunch') },
            (err, stdout, stderr) => {
              if (err) {
                sendOOBELog(`Error: ${err}`);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              sendOOBELog(stdout);
              sendOOBELog(stderr);
              // run chmod +x on the file
              exec(
                'chmod +x ' +
                  join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                (err, stdout, stderr) => {
                  if (err) {
                    sendOOBELog(`Error: ${err}`);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }
                  sendOOBELog(stdout);
                  sendOOBELog(stderr);
                  sendNotification({
                    message: 'Successfully updated steamtinkerlaunch.',
                    id: Math.random().toString(36).substring(7),
                    type: 'info',
                  });
                  resolve();
                }
              );
            }
          );
        });
      }
    } else if (process.platform === 'linux') {
      // check if steamtinkerlaunch is installed in that path
      if (!fs.existsSync(STEAMTINKERLAUNCH_PATH)) {
        const nixosMsg = IS_NIXOS
          ? 'SteamTinkerLaunch is not installed. On NixOS, add "steamtinkerlaunch" to your system packages.'
          : 'SteamTinkerLaunch is not installed. Please install it manually.';
        sendNotification({
          message: nixosMsg,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        cleanlyDownloadedAll = false;
      }
    }

    // check if bun is installed
    const bunInstalled = await new Promise<boolean>((resolve, _) => {
      exec('bun --version', (err, stdout, _) => {
        if (err) {
          resolve(false);
        }
        sendOOBELog(stdout);
        resolve(true);
      });
    });

    if (!bunInstalled) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) =>
          exec(
            'powershell -c "irm bun.sh/install.ps1 | iex"',
            (err, stdout, stderr) => {
              if (err) {
                sendOOBELog(`Error: ${err}`);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              sendOOBELog(stdout);
              sendOOBELog(stderr);
              sendNotification({
                message: 'Successfully installed bun.',
                id: Math.random().toString(36).substring(7),
                type: 'info',
              });
              requireRestart = true;
              resolve();
            }
          )
        );
      } else if (process.platform === 'linux' && !IS_NIXOS) {
        await new Promise<void>((resolve, reject) => {
          exec(
            'curl -fsSL https://bun.sh/install | bash',
            (err, stdout, stderr) => {
              // then export to path
              if (err) {
                sendOOBELog(`Error: ${err}`);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              sendOOBELog(stdout);
              sendOOBELog(stderr);
              // get linux name
              const linuxName = os.userInfo().username;

              exec(
                'echo "export PATH=$PATH:/home/' +
                  linuxName +
                  '/.bun/bin" >> ~/.bashrc',
                (err, stdout, stderr) => {
                  if (err) {
                    sendOOBELog(`Error: ${err}`);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }
                  sendOOBELog(stdout);
                  sendOOBELog(stderr);
                  sendNotification({
                    message: 'Successfully installed bun and added to path.',
                    id: Math.random().toString(36).substring(7),
                    type: 'info',
                  });
                  resolve();
                  requireRestart = true;
                }
              );
            }
          );
        });
      } else if (process.platform === 'linux' && IS_NIXOS) {
        sendNotification({
          message:
            'Bun is not installed. On NixOS, add "bun" to your system packages or run: nix-env -iA nixpkgs.bun',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        cleanlyDownloadedAll = false;
      }
    } else if (!IS_NIXOS) {
      await new Promise<void>((resolve) =>
        exec('bun upgrade', (err, stdout, stderr) => {
          if (err) {
            sendOOBELog(`Error: ${err}`);
            // reject();
            resolve();
            return;
          }
          sendOOBELog(stdout);
          sendOOBELog(stderr);
          sendNotification({
            message: 'Successfully upgraded bun.',
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });
          resolve();
        })
      );
    }

    // on linux, UMU launcher handles Wine/Proton compatibility automatically.
    // UMU is auto-installed and managed by the built-in updater — no manual wine setup is needed.
    if (process.platform === 'linux') {
      sendOOBELog(
        'Wine compatibility is handled automatically by UMU launcher (auto-installed).'
      );
    }
    return [cleanlyDownloadedAll, requireRestart];
  });

  ipcMain.handle('oobe:set-steamgriddb-key', async (_, key: string) => {
    // send to steamtinkerlaunch the new key using STEAMTINKERLAUNCH_PATH
    try {
      await new Promise<void>((resolve, reject) =>
        exec(
          STEAMTINKERLAUNCH_PATH + ' set SGDBAPIKEY global ' + key,
          (err, stdout, stderr) => {
            if (err) {
              sendOOBELog(`Error: ${err}`);
              reject();
              return;
            }
            sendOOBELog(stdout);
            sendOOBELog(stderr);
            resolve();
          }
        )
      );
      return true;
    } catch (err) {
      sendOOBELog(`Error: ${err}`);
      return false;
    }
  });
}
