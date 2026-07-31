import { AddonError, AddonNotFound, ipcBoundary } from '@ogi/errors';
import axios from 'axios';
import { exec } from 'child_process';
import { Effect, Schedule } from 'effect';
import { BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import fsAsync from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import {
  normalizeAddonLink,
  parseAddonLink,
} from '@/electron/lib/addon-links.js';
import { AddonMarketplace } from '@/electron/lib/marketplace.js';
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

export function startAddons(): Effect.Effect<void, AddonError> {
  return Effect.gen(function* () {
    const configPath = join(__dirname, 'config/option/general.json');
    const addons = yield* Effect.try({
      try: () => {
        if (!fs.existsSync(configPath)) return [] as string[];
        const generalConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return generalConfig.addons as string[];
      },
      catch: (cause) =>
        new AddonError({
          message: `Failed to read addon configuration: ${String(cause)}`,
        }),
    });

    yield* Effect.forEach(
      addons,
      (addon) =>
        Effect.gen(function* () {
          const parsedAddon = yield* Effect.try({
            try: () => parseAddonLink(addon),
            catch: (cause) =>
              new AddonError({
                message: `Invalid addon link ${addon}: ${String(cause)}`,
              }),
          });
          const addonPath =
            parsedAddon.kind === 'local'
              ? parsedAddon.path
              : join(__dirname, 'addons', parsedAddon.addonName);

          if (!fs.existsSync(addonPath)) {
            console.error(`Addon ${addonPath} does not exist`);
            sendNotification({
              message: `Addon ${addonPath} does not exist`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
            return;
          }

          if (!fs.existsSync(join(addonPath, 'installation.log'))) {
            console.log(`Addon ${addonPath} has not been installed yet.`);
            return;
          }

          console.log(`Starting addon ${addonPath}`);
          const instance = yield* Addon.load(addonPath).pipe(
            Effect.catchAll(() => Effect.succeed(null))
          );
          if (instance) {
            yield* instance.startRegistered(parsedAddon.normalized);
          }
        }).pipe(Effect.catchAll(() => Effect.void)),
      { concurrency: 'unbounded', discard: true }
    );
    console.log('All addons started');
  });
}

const HEALTH_CHECK_INTERVAL_MS = 500;
const MAX_ATTEMPTS_HEALTH_CHECK = 60;
const HEALTH_CHECK_TIMEOUT_MS =
  MAX_ATTEMPTS_HEALTH_CHECK * HEALTH_CHECK_INTERVAL_MS;

export function restartAddonServer(): Effect.Effect<void, AddonError> {
  return Effect.gen(function* () {
    console.log('Stopping server...');
    yield* stopAddonServer().pipe(
      Effect.mapError(
        (cause) =>
          new AddonError({
            message: `Failed to stop addon server: ${String(cause)}`,
          })
      )
    );
    yield* Effect.forEach(
      [...Addon.running.values()],
      (instance) => {
        console.log(`Stopping addon ${instance.config.path}`);
        return instance.stop().pipe(
          Effect.mapError(
            (cause) =>
              new AddonError({
                message: `Failed to stop addon ${instance.config.path}: ${String(cause)}`,
              })
          )
        );
      },
      { concurrency: 'unbounded', discard: true }
    );

    yield* startAddonServer().pipe(
      Effect.mapError(
        (cause) =>
          new AddonError({
            message: `Failed to start addon server: ${String(cause)}`,
          })
      )
    );

    const checkHealth = Effect.tryPromise({
      try: () => axios.get(`http://localhost:${port}/health`, { timeout: 500 }),
      catch: () => new AddonError({ message: 'Addon health check failed' }),
    });
    const healthCheckSchedule = Schedule.exponential(
      `${HEALTH_CHECK_INTERVAL_MS} millis`
    ).pipe(Schedule.compose(Schedule.recurs(MAX_ATTEMPTS_HEALTH_CHECK)));

    yield* checkHealth.pipe(
      Effect.retry(healthCheckSchedule),
      Effect.mapError(
        () =>
          new AddonError({
            message: `Failed to start addon server: health check failed after ${MAX_ATTEMPTS_HEALTH_CHECK} attempts (${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`,
          })
      )
    );

    console.log(`Addon Server is running on http://localhost:${port}`);
    console.log(`Server is being executed by electron!`);
    yield* startAddons();
    const configuredAddons = yield* waitForAddonsConfigured();
    for (const connection of configuredAddons) {
      yield* Effect.tryPromise({
        try: () => sendIPCMessage('addon-connected', connection.addonInfo!.id),
        catch: (cause) =>
          new AddonError({
            message: `Failed to notify renderer: ${String(cause)}`,
          }),
      });
    }
    yield* Effect.tryPromise({
      try: () => sendIPCMessage('addon-runtime-ready'),
      catch: (cause) =>
        new AddonError({
          message: `Failed to notify renderer: ${String(cause)}`,
        }),
    });

    sendNotification({
      message: 'Addon server restarted successfully.',
      id: Math.random().toString(36).substring(7),
      type: 'success',
    });
  });
}

export function loadMarketplace(
  url: string,
  options?: { refresh?: boolean }
): Effect.Effect<AddonMarketplace> {
  return Effect.gen(function* () {
    const refresh = options?.refresh === true;
    let marketplace = loadedMarketplaces.find((m) => m.url === url);

    if (marketplace && refresh) {
      yield* marketplace.fetch();
      return marketplace;
    }

    if (!marketplace) {
      const newMarketplace = new AddonMarketplace(url);
      const ok = yield* newMarketplace.fetch();
      if (!ok) return newMarketplace;
      console.log(
        `[addon-handler] Loaded marketplace from ${url}.`,
        newMarketplace.getAddons()
      );
      loadedMarketplaces.push(newMarketplace);
      marketplace = newMarketplace;
    }
    return marketplace;
  });
}

export default function AddonManagerHandler(mainWindow: BrowserWindow) {
  ipcMain.handle(
    'install-addons',
    ipcBoundary((_, addons: string[]) =>
      Effect.gen(function* () {
        // addons is an array of URLs to the addons to install. these should be valid git repositories
        addons = Array.isArray(addons)
          ? addons
              .filter((addon) => typeof addon === 'string')
              .map((addon) => addon.trim())
              .filter(Boolean)
          : [];

        const generalConfigPath = join(
          __dirname,
          'config',
          'option',
          'general.json'
        );
        const stagedUpdate = yield* Effect.tryPromise({
          try: async () =>
            JSON.parse(
              await fsAsync.readFile(generalConfigPath, { encoding: 'utf-8' })
            ) as { addons: string[] },
          catch: (cause) =>
            new AddonError({
              message: `Failed to read addon configuration: ${String(cause)}`,
            }),
        });
        if (addons.length === 0) {
          sendNotification({
            message: 'No addons to install',
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
          return;
        }

        const addonsPath = join(__dirname, 'addons/');
        yield* Effect.try({
          try: () => {
            if (!fs.existsSync(addonsPath)) fs.mkdirSync(addonsPath);
          },
          catch: (cause) =>
            new AddonError({
              message: `Failed to create addons directory: ${String(cause)}`,
            }),
        });

        // check if git is installed
        const gitInstalled = yield* Effect.async<boolean>((resume) => {
          exec('git --version', (err, stdout, _) => {
            if (err) {
              resume(Effect.succeed(false));
              return;
            }
            console.log(stdout);
            resume(Effect.succeed(true));
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
          const parsedAddon = yield* Effect.try({
            try: () => parseAddonLink(addonUrlWithMarketplace),
            catch: (cause) =>
              new AddonError({
                message: `Invalid addon link ${addonUrlWithMarketplace}: ${String(cause)}`,
              }),
          });
          const addonName = parsedAddon.addonName;
          const isLocal = parsedAddon.kind === 'local';
          const gitUrl =
            parsedAddon.kind === 'local' ? undefined : parsedAddon.gitUrl;
          let addonPath = join(__dirname, `addons/${addonName}`);
          if (parsedAddon.kind === 'local') {
            addonPath = parsedAddon.path;
          }
          let clonedThisInstall = false;

          yield* Effect.gen(function* () {
            const isInstalled = yield* Effect.try({
              try: () => fs.existsSync(join(addonPath, 'installation.log')),
              catch: (cause) =>
                new AddonError({
                  message: `Failed to inspect addon ${addonName}: ${String(cause)}`,
                  addonName,
                }),
            });
            if (isInstalled) {
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
              return;
            }

            const hasAddonConfig = yield* Effect.try({
              try: () => fs.existsSync(join(addonPath, 'addon.json')),
              catch: (cause) =>
                new AddonError({
                  message: `Failed to inspect addon ${addonName}: ${String(cause)}`,
                  addonName,
                }),
            });
            if (!isLocal && !hasAddonConfig) {
              // Validate git URL/SSH pattern before cloning
              const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/;
              if (!gitUrl || !gitUrlPattern.test(gitUrl)) {
                sendNotification({
                  message: `Invalid git URL format for addon ${addonName}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                return;
              }

              const unloadedAddon = new Addon.Git({ path: addonPath });
              yield* unloadedAddon.clone(gitUrl);
              clonedThisInstall = true;

              if (parsedAddon.kind === 'marketplace') {
                const marketplace = yield* loadMarketplace(
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
                  if (clonedThisInstall) {
                    yield* Effect.try({
                      try: () =>
                        fs.rmSync(addonPath, { recursive: true, force: true }),
                      catch: (cause) =>
                        new AddonError({
                          message: `Failed to clean up addon ${addonName}: ${String(cause)}`,
                          addonName,
                        }),
                    });
                  }
                  return;
                }

                if (parsedAddon.explicitRef) {
                  yield* unloadedAddon.fetchRef(
                    'origin',
                    parsedAddon.explicitRef
                  );
                  yield* unloadedAddon.checkoutCommit('FETCH_HEAD');
                } else if (
                  addonFromMarketplace.pinnedCommit &&
                  addonFromMarketplace.pinnedCommit !== 'latest'
                ) {
                  yield* unloadedAddon.checkoutCommit(
                    addonFromMarketplace.pinnedCommit
                  );
                } else {
                  console.log('Defaulting to latest commit.');
                }
              }
            }

            const instance = yield* Addon.load(addonPath).pipe(
              Effect.catchAll(() => Effect.succeed(null))
            );
            const hasAddonBeenSetup = instance
              ? yield* instance.install()
              : false;
            if (!hasAddonBeenSetup) {
              sendNotification({
                message: `An error occurred when setting up ${addonName}`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              if (clonedThisInstall) {
                yield* Effect.try({
                  try: () =>
                    fs.rmSync(addonPath, { recursive: true, force: true }),
                  catch: (cause) =>
                    new AddonError({
                      message: `Failed to clean up addon ${addonName}: ${String(cause)}`,
                      addonName,
                    }),
                });
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
          }).pipe(
            Effect.catchAll((installErr) =>
              Effect.gen(function* () {
                console.error(
                  `Failed to install addon ${addonName}:`,
                  installErr
                );
                sendNotification({
                  message: `An error occurred when installing ${addonName}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                if (clonedThisInstall) {
                  // Clean up a partial clone so retries do not install from an unpinned default branch.
                  yield* Effect.try({
                    try: () =>
                      fs.rmSync(addonPath, { recursive: true, force: true }),
                    catch: (cause) =>
                      new AddonError({
                        message: `Failed to clean up addon ${addonName}: ${String(cause)}`,
                        addonName,
                      }),
                  }).pipe(Effect.catchAll(() => Effect.void));
                }
              })
            )
          );
        }
        yield* Effect.tryPromise({
          try: () =>
            fsAsync.writeFile(
              generalConfigPath,
              JSON.stringify(stagedUpdate),
              'utf-8'
            ),
          catch: (cause) =>
            new AddonError({
              message: `Failed to write addon configuration: ${String(cause)}`,
            }),
        });
        yield* restartAddonServer();
        return stagedUpdate.addons;
      })
    )
  );

  ipcMain.handle(
    'restart-addon-server',
    ipcBoundary(() => restartAddonServer())
  );

  ipcMain.handle(
    'addon:delete-installed',
    ipcBoundary((_, addonID: string) =>
      Effect.gen(function* () {
        if (typeof addonID !== 'string' || addonID.trim().length === 0) {
          return { success: false, message: 'Invalid addon ID' };
        }
        return yield* deleteInstalledAddon(addonID);
      })
    )
  );

  ipcMain.handle(
    'clean-addons',
    ipcBoundary((_, marketplaceUrls: string[]) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [...Addon.running.values()],
          (instance) => {
            console.log(`Stopping addon ${instance.config.path}`);
            return instance.stop();
          },
          { concurrency: 'unbounded', discard: true }
        );

        // delete specific addons in marketplaceUrls
        yield* Effect.forEach(
          marketplaceUrls,
          (addonURL) =>
            Effect.try({
              try: () => {
                const parsedAddon = parseAddonLink(addonURL);
                const addonPath =
                  parsedAddon.kind === 'local'
                    ? parsedAddon.path
                    : join(__dirname, 'addons', parsedAddon.addonName);
                if (fs.existsSync(addonPath)) {
                  fs.rmSync(addonPath, { recursive: true, force: true });
                }
              },
              catch: (cause) =>
                new AddonError({
                  message: `Failed to clean addon ${addonURL}: ${String(cause)}`,
                }),
            }),
          { concurrency: 'unbounded', discard: true }
        );

        sendNotification({
          message: 'Successfully cleaned addons.',
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
      })
    )
  );

  ipcMain.handle(
    'update-addons',
    ipcBoundary((_) =>
      Effect.gen(function* () {
        // check if wifi is available
        const isWifiAvailable = yield* Effect.tryPromise({
          try: async () => {
            await axios.get('https://www.google.com');
            return true;
          },
          catch: (cause) =>
            new AddonError({
              message: `Failed to check internet connection: ${String(cause)}`,
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (!isWifiAvailable) {
          console.error('No internet connection. Not updating addons.');
          return;
        }

        yield* Effect.forEach(
          [...Addon.running.values()],
          (instance) => {
            console.log(`Stopping addon ${instance.config.path}`);
            return instance.stop();
          },
          { concurrency: 'unbounded', discard: true }
        );

        // pull all of the addons
        const config = yield* Effect.try({
          try: () => {
            if (!fs.existsSync(join(__dirname, 'addons/'))) return null;
            const generalConfig = JSON.parse(
              fs.readFileSync(
                join(__dirname, 'config/option/general.json'),
                'utf-8'
              )
            ) as { addons: string[] };
            return {
              addons: generalConfig.addons,
              normalizedAddons: generalConfig.addons.map((addon) =>
                normalizeAddonLink(addon)
              ),
            };
          },
          catch: (cause) =>
            new AddonError({
              message: `Failed to read addon configuration: ${String(cause)}`,
            }),
        });
        if (!config) return;
        const { addons, normalizedAddons } = config;

        const results = yield* Effect.forEach(
          normalizedAddons,
          (addonWithMarketplace) =>
            Effect.gen(function* () {
              const parsedAddon = yield* Effect.try({
                try: () => parseAddonLink(addonWithMarketplace),
                catch: (cause) =>
                  new AddonError({
                    message: `Invalid addon link ${addonWithMarketplace}: ${String(cause)}`,
                  }),
              });
              const addonPath =
                parsedAddon.kind === 'local'
                  ? parsedAddon.path
                  : join(__dirname, 'addons', parsedAddon.addonName);
              const marketplaceUrl =
                parsedAddon.kind === 'marketplace'
                  ? parsedAddon.marketplaceUrl
                  : parsedAddon.kind;
              const gitUrl =
                parsedAddon.kind === 'local' ? undefined : parsedAddon.gitUrl;
              const addonName = parsedAddon.addonName;

              const isRepository = yield* Effect.try({
                try: () => isGitRepository(addonPath),
                catch: (cause) =>
                  new AddonError({
                    message: `Failed to inspect addon ${addonName}: ${String(cause)}`,
                    addonName,
                  }),
              });
              if (!isRepository) {
                console.log(
                  `Skipping addon update for ${addonName}: ${addonPath} is not a valid git repository`
                );
                return;
              }

              if (parsedAddon.kind === 'local') return;

              console.log(addonPath);
              const addonJSON = yield* Addon.Setup.loadAddonConfig(addonPath);
              const addonSetup = new Addon.Setup({
                name: addonName,
                path: addonPath,
                scripts: addonJSON.scripts,
              });

              const fetchResult = yield* Effect.either(
                Effect.gen(function* () {
                  return {
                    alreadyUpToDate: (yield* addonSetup.git.fetch())
                      .alreadyUpToDate,
                    currentHash: yield* addonSetup.git.getCurrentHash(),
                  };
                })
              );
              if (fetchResult._tag === 'Left') {
                sendNotification({
                  message: `Failed to update addon ${addonName}`,
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                return yield* Effect.fail(fetchResult.left);
              }
              const fetchData = fetchResult.right;
              console.log(marketplaceUrl, addonName, gitUrl);
              let alreadyUpToDate = fetchData.alreadyUpToDate;

              if (parsedAddon.kind === 'marketplace') {
                const marketplace = yield* loadMarketplace(
                  parsedAddon.marketplaceUrl,
                  { refresh: true }
                );

                const marketplaceAddon = marketplace.getAddon(gitUrl!);
                if (!marketplaceAddon) {
                  sendNotification({
                    message: `Could not find ${addonName} in marketplace.`,
                    id: Math.random().toString(36).substring(7),
                    type: 'error',
                  });
                  return yield* Effect.fail(new AddonNotFound({ addonName }));
                }

                let pinnedCommit = marketplaceAddon.pinnedCommit ?? 'latest';
                if (parsedAddon.explicitRef) {
                  yield* addonSetup.git.fetchRef(
                    'origin',
                    parsedAddon.explicitRef
                  );
                  pinnedCommit = yield* addonSetup.git.resolveRef('FETCH_HEAD');
                }
                alreadyUpToDate =
                  pinnedCommit === 'latest'
                    ? fetchData.alreadyUpToDate
                    : fetchData.currentHash === pinnedCommit;
                if (alreadyUpToDate && (yield* addonSetup.isInstalled())) {
                  sendNotification({
                    message: `Addon ${addonName} is already up to date.`,
                    id: Math.random().toString(36).substring(7),
                    type: 'info',
                  });
                  mainWindow.webContents.send(
                    'addon:updated',
                    addonWithMarketplace
                  );
                  return;
                }

                if (pinnedCommit !== 'latest') {
                  yield* addonSetup.git.checkoutCommit(
                    parsedAddon.explicitRef ? 'FETCH_HEAD' : pinnedCommit
                  );
                } else if (!alreadyUpToDate) {
                  yield* addonSetup.git.pull();
                }
              } else if (alreadyUpToDate && (yield* addonSetup.isInstalled())) {
                sendNotification({
                  message: `Addon ${addonName} is already up to date.`,
                  id: Math.random().toString(36).substring(7),
                  type: 'info',
                });
                mainWindow.webContents.send(
                  'addon:updated',
                  addonWithMarketplace
                );
                return;
              } else {
                yield* addonSetup.git.pull();
              }

              if (alreadyUpToDate) {
                console.log(
                  `Addon ${addonName} is already up to date, but installation.log is missing. Running setup.`
                );
              } else if (yield* addonSetup.isInstalled()) {
                // get rid of the installation log because not up-to-date
                yield* Effect.try({
                  try: () => fs.unlinkSync(join(addonPath, 'installation.log')),
                  catch: (cause) =>
                    new AddonError({
                      message: `Failed to reset addon ${addonName}: ${String(cause)}`,
                      addonName,
                    }),
                });
              }

              const instance = yield* Addon.load(addonPath).pipe(
                Effect.catchAll(() => Effect.succeed(null))
              );
              if (!instance) {
                return yield* Effect.fail(
                  new AddonError({
                    message: `Failed to load addon ${addonName}`,
                    addonName,
                  })
                );
              }

              yield* Effect.gen(function* () {
                const success = yield* instance.install();
                if (!success || !(yield* instance.setup.isInstalled())) {
                  return yield* Effect.fail(
                    new AddonError({
                      message: `Failed to setup addon ${addonName}`,
                      addonName,
                    })
                  );
                }

                sendNotification({
                  message: alreadyUpToDate
                    ? `Addon ${addonName} setup completed successfully.`
                    : `Addon ${addonName} updated successfully.`,
                  id: Math.random().toString(36).substring(7),
                  type: 'info',
                });
                mainWindow.webContents.send(
                  'addon:updated',
                  addonWithMarketplace
                );
                console.log(
                  `Addon ${addonName} updated and setup successfully.`
                );
              }).pipe(
                Effect.tapError(() =>
                  Effect.sync(() =>
                    sendNotification({
                      message: `An error occurred when setting up ${addonName}`,
                      id: Math.random().toString(36).substring(7),
                      type: 'error',
                    })
                  )
                )
              );
            }).pipe(Effect.either),
          { concurrency: 'unbounded' }
        );

        let failedCount = 0;
        results.forEach((result, index) => {
          if (result._tag === 'Left') {
            failedCount++;
            console.error(
              `Addon update failed for ${addons[index]}:`,
              result.left
            );
          }
        });

        if (failedCount > 0) {
          console.log(`${failedCount} addons failed to update.`);
        }

        // restart all of the addons
        yield* restartAddonServer();

        if (failedCount === addons.length) {
          sendNotification({
            message: 'All addons failed to update.',
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
        } else if (failedCount === 0) {
          sendNotification({
            message: 'Successfully updated addons.',
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });
        } else {
          sendNotification({
            message: `Updated addons with ${failedCount} failure${failedCount === 1 ? '' : 's'}.`,
            id: Math.random().toString(36).substring(7),
            type: 'warning',
          });
        }
      })
    )
  );
}
