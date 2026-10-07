import type { DatabaseError, FileSystemError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { exec, spawn } from 'child_process';
import { Effect } from 'effect';
import * as fsSync from 'fs';
import * as os from 'os';
import { join } from 'path';
import semver from 'semver';
import { addToDesktop } from '@/electron/handlers/helpers.app/desktop-shortcut.js';
import { normalizeAddonLink } from '@/electron/lib/addon-links.js';
import { migrateLegacySteamGridDbKey } from '@/electron/lib/steam-grid-db.js';
import { sendIPCMessage, sendNotification, VERSION } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import {
  type AppServices,
  Database,
  Settings,
} from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

let migrations: {
  [key: string]: {
    from: string;
    to: string;
    description: string;
    platform: 'linux' | 'win32' | 'all';
    run: () => Promise<void> | Effect.Effect<void, unknown, AppServices>;
  };
} = {
  'install-steam-addon': {
    from: '1.6.8',
    to: '2.0.0',
    description: `Adds the Steam Catalog addon to the user's addons list. This is required because the user expects Steam listings to appear, but because the built-in Steam catalog was removed, this addon is needed to provide the same functionality.`,
    platform: 'all',
    run: () =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const addons = yield* settings.addons;
        if (
          !addons.some((addon) => addon.includes('Nat3z/steam-integration'))
        ) {
          yield* settings.setAddons([
            ...addons,
            'https://github.com/Nat3z/steam-integration',
          ]);
        }
        yield* Effect.promise(() =>
          sendIPCMessage('migration:event', 'install-steam-addon')
        );
      }),
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
    run: () =>
      Effect.gen(function* () {
        const addons = yield* (yield* Settings).addons;
        const hasSteamAddon = addons.some((addon) =>
          addon.includes('Nat3z/steam-integration')
        );
        if (!hasSteamAddon) {
          logger.sync.info(
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
          logger.sync.info('already installed, no need to repair.');
          return;
        }

        logger.sync.info('repairing steam-integration through installation...');
        yield* Effect.promise(() =>
          sendIPCMessage('migration:event', 'install-steam-addon')
        );
      }),
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
            logger.sync.info('[migration] flatpak not installed');
            resolve(false);
          } else {
            logger.sync.info('[migration] flatpak version:', stdout.trim());
            resolve(true);
          }
        });
      });

      if (!flatpakInstalled) {
        logger.sync.info(
          '[migration] flatpak not available, skipping wine installation'
        );
        return;
      }

      // Check if wine is already installed
      const wineInstalled = await new Promise<boolean>((resolve) => {
        exec('flatpak run org.winehq.Wine --help', (err) => {
          if (err) {
            logger.sync.info('[migration] wine not installed via flatpak');
            resolve(false);
          } else {
            logger.sync.info('[migration] wine already installed via flatpak');
            resolve(true);
          }
        });
      });

      if (wineInstalled) {
        logger.sync.info('[migration] wine already installed, skipping');
        return;
      }

      // Install wine through flatpak
      logger.sync.info('[migration] installing wine via flatpak...');
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
            logger.sync.info('[migration] wine install stdout:', dataStr);
          });
        }

        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const dataStr = data.toString();
            stderr += dataStr;
            logger.sync.info('[migration] wine install stderr:', dataStr);
          });
        }

        childProcess.on('close', (code: number) => {
          logger.sync.info(
            '[migration] wine install process exited with code:',
            code
          );
          if (code !== 0) {
            logger.sync.info('[migration] wine installation failed');
            resolve(false);
            return;
          }
          logger.sync.info('[migration] wine installation successful');
          resolve(true);
        });

        childProcess.on('error', (err: Error) => {
          logger.sync.info('[migration] wine install error:', err);
          resolve(false);
        });
      });

      if (!result) {
        logger.sync.info('[migration] failed to install wine through flatpak');
        return;
      }

      // Verify wine installation
      const wineVerification = await new Promise<boolean>((resolve) => {
        exec('flatpak run org.winehq.Wine --help', (err) => {
          if (err) {
            logger.sync.info('[migration] wine verification failed');
            resolve(false);
          } else {
            logger.sync.info('[migration] wine verification successful');
            resolve(true);
          }
        });
      });

      if (!wineVerification) {
        logger.sync.info('[migration] wine installation verification failed');
      } else {
        logger.sync.info(
          '[migration] wine installation completed successfully'
        );
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
    run: () =>
      addToDesktop().pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            sendNotification({
              message:
                'Desktop shortcut created successfully. You can now find OpenGameInstaller in your Desktop.',
              id: Math.random().toString(36).substring(7),
              type: 'success',
            })
          )
        )
      ),
  },
  'repair-desktop-shortcut-icon': {
    from: '2.5.0',
    to: '4.3.0',
    description:
      'Rewrites the desktop shortcut so its icon lives in the OGI data dir instead of the update dir the updater wipes.',
    platform: 'linux',
    run: () =>
      Effect.gen(function* () {
        const desktopFilePath = join(
          os.homedir(),
          'Desktop',
          'OpenGameInstaller.desktop'
        );
        // If the user removed the shortcut, respect that and do nothing.
        if (!fsSync.existsSync(desktopFilePath)) return;
        yield* addToDesktop();
      }),
  },
  'migrate-addon-source-associations': {
    from: '0.0.0',
    to: '4.1.0',
    description:
      'Migrates legacy bare addon repository URLs to explicit marketplace or git associations.',
    platform: 'all',
    run: () =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const originalAddons = yield* settings.addons;
        const migratedAddons = originalAddons.map((addon) =>
          normalizeAddonLink(addon)
        );

        const changed = migratedAddons.some(
          (addon, index) => addon !== originalAddons[index]
        );
        if (!changed) {
          logger.sync.info(
            '[migration] addon source associations already migrated'
          );
          return;
        }

        yield* settings.setAddons([...new Set(migratedAddons)]);
        logger.sync.info('[migration] migrated addon source associations');
      }),
  },
  'migrate-steamtinkerlaunch-steamgriddb-key': {
    from: '0.0.0',
    to: '4.1.0',
    description:
      'Migrates the SteamGridDB API key from the legacy SteamTinkerLaunch configuration.',
    platform: 'linux',
    run: () =>
      Effect.gen(function* () {
        const status = yield* migrateLegacySteamGridDbKey();
        logger.sync.info(`[migration] SteamGridDB key: ${status}`);
      }),
  },
};
/**
 * Runs every migration that applies to the version recorded in the database,
 * then records the current version. A fresh install skips straight to
 * recording the version.
 */
export function execute(): Effect.Effect<
  void,
  FileSystemError | DatabaseError,
  AppServices
> {
  return Effect.gen(function* () {
    const database = yield* Database;
    const appState = yield* database.appState.get;
    // A fresh install has nothing to migrate; just record the version it
    // started on so the next upgrade knows where it came from.
    if (!appState.installed) {
      yield* database.appState.update({ lastVersion: VERSION });
      return;
    }

    const lastVersion = appState.lastVersion ?? '0.0.0';
    logger.sync.info('[migration] local version:', lastVersion);
    for (const migration of Object.values(migrations)) {
      if (
        semver.gte(lastVersion, migration.from) &&
        semver.lt(lastVersion, migration.to) &&
        (migration.platform === 'all' ||
          migration.platform === process.platform)
      ) {
        logger.sync.info(
          `[migration] ${migration.description}\n - from: ${migration.from}\n - to: ${migration.to}`
        );
        const operation = migration.run();
        yield* (
          Effect.isEffect(operation)
            ? operation
            : Effect.tryPromise({
                try: () => operation,
                catch: (cause) => cause,
              })
        ).pipe(
          Effect.tap(() => logger.info('[migration] completed')),
          Effect.catchAll((error) =>
            logger.error(`[migration] failed: ${error}`)
          )
        );
      }
    }

    yield* database.appState.update({ lastVersion: VERSION });
  });
}
