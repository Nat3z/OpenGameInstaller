import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { __dirname } from '../paths.js';
import fs from 'fs';
import { join } from 'path';
import axios from 'axios';
import { sendNotification } from '../main.js';
import { IS_NIXOS, STEAMTINKERLAUNCH_PATH } from '../startup.js';
import os from 'os';

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
          console.log(stdout);
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
                console.log('Downloaded 7zip');
                fileStream.close();
                exec(
                  '7z-install.exe /S /D="C:\\Program Files\\7-Zip"',
                  (err, stdout, stderr) => {
                    if (err) {
                      console.error(err);
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
                    console.log(stdout);
                    console.log(stderr);
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
                console.error(err);
                fileStream.close();
                fs.unlinkSync(join(__dirname, '7z-install.exe'));
                cleanlyDownloadedAll = false;
              });
            })
            .catch((err) => {
              console.error(err);
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
        console.log(stdout);
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
                console.log('Downloaded git');
                fileStream.close();

                fs.writeFileSync(
                  'git_install.ini',
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
                      console.error(err);
                      reject();
                      cleanlyDownloadedAll = false;
                      return;
                    }
                    console.log(stdout);
                    console.log(stderr);
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
                console.error(err);
                fileStream.close();
                fs.unlinkSync(join(__dirname, 'git-install.exe'));
              });
            })
            .catch((err) => {
              console.error(err);
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
                console.error(err);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              console.log(stdout);
              console.log(stderr);
              // run chmod +x on the file
              exec(
                'chmod +x ' +
                  join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                (err) => {
                  if (err) {
                    console.error(err);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }

                  // now executing steamtinkerlaunch
                  exec(
                    join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                    (err, stdout, stderr) => {
                      if (err) {
                        console.error(err);
                        reject();
                        cleanlyDownloadedAll = false;
                        return;
                      }
                      console.log(stdout);
                      console.log(stderr);
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
                console.error(err);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              console.log(stdout);
              console.log(stderr);
              // run chmod +x on the file
              exec(
                'chmod +x ' +
                  join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'),
                (err, stdout, stderr) => {
                  if (err) {
                    console.error(err);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }
                  console.log(stdout);
                  console.log(stderr);
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
        sendNotification({
          message:
            'SteamTinkerLaunch is not installed. You are not on a supported OS. Please install it manually.',
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
        console.log(stdout);
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
                console.error(err);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              console.log(stdout);
              console.log(stderr);
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
                console.error(err);
                reject();
                cleanlyDownloadedAll = false;
                return;
              }
              console.log(stdout);
              console.log(stderr);
              // get linux name
              const linuxName = os.userInfo().username;

              exec(
                'echo "export PATH=$PATH:/home/' +
                  linuxName +
                  '/.bun/bin" >> ~/.bashrc',
                (err, stdout, stderr) => {
                  if (err) {
                    console.error(err);
                    reject();
                    cleanlyDownloadedAll = false;
                    return;
                  }
                  console.log(stdout);
                  console.log(stderr);
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
            'Bun is not installed. You are not on a supported OS. Please install it manually.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        cleanlyDownloadedAll = false;
      }
    } else if (!IS_NIXOS) {
      await new Promise<void>((resolve) =>
        exec('bun upgrade', (err, stdout, stderr) => {
          if (err) {
            console.error(err);
            // reject();
            resolve();
            return;
          }
          console.log(stdout);
          console.log(stderr);
          sendNotification({
            message: 'Successfully upgraded bun.',
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });
          resolve();
        })
      );
    }

    return [cleanlyDownloadedAll, requireRestart];
  });
}
