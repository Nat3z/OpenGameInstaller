import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConfigError,
  PlatformError,
  SikarugirError,
  SteamShortcutConflictError,
  SteamVdfParseError,
} from '@ogi-sdk/errors';
import { Context, Effect, Layer } from 'effect';
import {
  type SteamLocation,
  SteamRepository,
  type SteamRepositoryError,
  SteamRepositoryLive,
} from '@/electron/lib/steam-installation.js';
import {
  findOwnedShortcut,
  readShortcuts,
  removeOwnedShortcut,
  type SteamShortcut,
  upsertShortcut,
} from '@/electron/lib/steam-shortcuts.js';
import { serializeBinaryVdf } from '@/electron/lib/steam-vdf.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { makeSikarugirLauncher, type SikarugirLauncher } from './launcher.js';
import {
  normalizeWinetricksVerbs,
  reconcileWinetricksVerbs,
  type WinetricksReconciliation,
} from './winetricks.js';

const WINDOWS_STEAM_EXECUTABLE = 'C:\\Program Files (x86)\\Steam\\steam.exe';
const CONFIGURATION_PATH = path.join(
  __dirname,
  'config',
  'option',
  'sikarugir.json'
);
const runtimeMutationLock = Effect.unsafeMakeSemaphore(1);

export interface SikarugirRuntimeConfiguration {
  readonly wrapperPath: string;
  readonly templateVersion: string;
  readonly engineVersion: string;
  readonly steamRootPath: string;
  readonly steamAccountId?: string;
}

export interface SikarugirGameConfiguration {
  readonly steamLaunchId?: string;
  readonly windowsExecutable: string;
  readonly windowsWorkingDirectory: string;
}

export type SikarugirWrapperReadiness =
  | {
      readonly ready: false;
      readonly reason: 'wrapper-missing' | 'wrapper-invalid';
      readonly wrapperPath: string;
      readonly message: string;
    }
  | {
      readonly ready: true;
      readonly wrapperPath: string;
      readonly launcherPath: string;
      readonly prefixPath: string;
      readonly configuredTemplateVersion: string;
      readonly configuredEngineVersion: string;
      readonly detectedEngineVersion?: string;
    };

export type SikarugirSetupState =
  | {
      readonly state: 'wrapper-missing';
      readonly readiness: Extract<SikarugirWrapperReadiness, { ready: false }>;
    }
  | { readonly state: 'prefix-missing' }
  | { readonly state: 'steam-not-installed' }
  | { readonly state: 'steam-login-required' }
  | {
      readonly state: 'ready';
      readonly steamAccountIds: readonly string[];
      readonly selectedSteamAccountId?: string;
      readonly steamAccountSelectionRequired: boolean;
    };

export interface SikarugirShortcutInput {
  readonly gameId: number;
  readonly appName: string;
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly knownAppId?: number;
  readonly launchOptions?: string;
  readonly icon?: string;
}

export interface SikarugirShortcutMutationResult {
  readonly appId?: number;
  readonly created?: boolean;
  readonly removed?: boolean;
}

export interface SikarugirWinetricksResult extends WinetricksReconciliation {
  readonly attempted: readonly string[];
}

export type SikarugirRuntimeError =
  | ConfigError
  | PlatformError
  | SikarugirError
  | SteamRepositoryError
  | SteamShortcutConflictError;

interface ResolvedWrapper {
  readonly configuration: SikarugirRuntimeConfiguration;
  readonly wrapperPath: string;
  readonly launcherPath: string;
  readonly prefixPath: string;
  readonly launcher: SikarugirLauncher;
}

const steamRootForWrapper = (wrapperPath: string): string =>
  path.join(
    wrapperPath,
    'Contents',
    'SharedSupport',
    'prefix',
    'drive_c',
    'Program Files (x86)',
    'Steam'
  );

const defaultConfiguration = (): SikarugirRuntimeConfiguration => {
  const wrapperPath = path.join(
    os.homedir(),
    'Applications',
    'Sikarugir',
    'Steam.app'
  );
  return {
    wrapperPath,
    templateVersion: '',
    engineVersion: '',
    steamRootPath: steamRootForWrapper(wrapperPath),
  };
};

const parseConfiguration = (value: unknown): SikarugirRuntimeConfiguration => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Configuration must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'wrapperPath',
    'templateVersion',
    'engineVersion',
    'steamRootPath',
  ] as const) {
    if (typeof record[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
  }
  if (
    record.steamAccountId !== undefined &&
    typeof record.steamAccountId !== 'string'
  ) {
    throw new Error('steamAccountId must be a string');
  }
  const wrapperPath = path.resolve(record.wrapperPath as string);
  return {
    wrapperPath,
    templateVersion: record.templateVersion as string,
    engineVersion: record.engineVersion as string,
    steamRootPath: steamRootForWrapper(wrapperPath),
    ...(record.steamAccountId
      ? { steamAccountId: record.steamAccountId as string }
      : {}),
  };
};

export const readSikarugirRuntimeConfiguration = (): Effect.Effect<
  SikarugirRuntimeConfiguration,
  ConfigError
> =>
  Effect.try({
    try: () => {
      if (!fs.existsSync(CONFIGURATION_PATH)) return defaultConfiguration();
      return parseConfiguration(
        JSON.parse(fs.readFileSync(CONFIGURATION_PATH, 'utf8')) as unknown
      );
    },
    catch: (cause) =>
      new ConfigError({
        message: `Could not read Sikarugir runtime configuration: ${String(cause)}`,
        key: 'sikarugir',
      }),
  });

export const writeSikarugirRuntimeConfiguration = (
  configuration: SikarugirRuntimeConfiguration
): Effect.Effect<SikarugirRuntimeConfiguration, ConfigError> =>
  Effect.try({
    try: () => {
      const normalized = parseConfiguration(configuration);
      fs.mkdirSync(path.dirname(CONFIGURATION_PATH), { recursive: true });
      const temporaryPath = `${CONFIGURATION_PATH}.ogi-${process.pid}-${Date.now()}.tmp`;
      try {
        fs.writeFileSync(
          temporaryPath,
          `${JSON.stringify(normalized, null, 2)}\n`,
          'utf8'
        );
        fs.renameSync(temporaryPath, CONFIGURATION_PATH);
      } finally {
        if (fs.existsSync(temporaryPath)) {
          fs.rmSync(temporaryPath, { force: true });
        }
      }
      return normalized;
    },
    catch: (cause) =>
      new ConfigError({
        message: `Could not write Sikarugir runtime configuration: ${String(cause)}`,
        key: 'sikarugir',
      }),
  });

const ensureDarwin = (): Effect.Effect<void, PlatformError> =>
  process.platform === 'darwin'
    ? Effect.void
    : Effect.fail(
        new PlatformError({
          message: 'Sikarugir is only supported on macOS',
          platform: process.platform,
        })
      );

const executeAbsolute = (
  executablePath: string,
  args: readonly string[],
  step: string
): Effect.Effect<string, SikarugirError> =>
  Effect.async<string, SikarugirError>((resume) => {
    const child = execFile(
      executablePath,
      [...args],
      {
        env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        // Sized for the largest caller (`ps -ax -o command=`), whose full
        // command lines can exceed the 1 MiB execFile default.
        maxBuffer: 16 * 1024 * 1024,
      },
      (cause, stdout, stderr) => {
        if (cause) {
          resume(
            Effect.fail(
              new SikarugirError({
                message: `${cause.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                step,
                cause,
              })
            )
          );
        } else {
          resume(Effect.succeed(stdout));
        }
      }
    );
    return Effect.sync(() => child.kill());
  });

const readLauncherPath = (
  wrapperPath: string
): Effect.Effect<string, SikarugirError> =>
  Effect.gen(function* () {
    const infoPlistPath = path.join(wrapperPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(infoPlistPath)) {
      return yield* Effect.fail(
        new SikarugirError({
          message: `Wrapper Info.plist does not exist at ${infoPlistPath}`,
          step: 'wrapper-readiness',
        })
      );
    }
    const executableName = (yield* executeAbsolute(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPlistPath],
      'wrapper-readiness'
    )).trim();
    if (!executableName) {
      return yield* Effect.fail(
        new SikarugirError({
          message: 'CFBundleExecutable is empty',
          step: 'wrapper-readiness',
        })
      );
    }
    const macOsPath = path.resolve(wrapperPath, 'Contents', 'MacOS');
    const launcherPath = path.resolve(macOsPath, executableName);
    if (!launcherPath.startsWith(`${macOsPath}${path.sep}`)) {
      return yield* Effect.fail(
        new SikarugirError({
          message: 'CFBundleExecutable points outside Contents/MacOS',
          step: 'wrapper-readiness',
        })
      );
    }
    const executable = yield* Effect.try({
      try: () => {
        fs.accessSync(launcherPath, fs.constants.X_OK);
        return launcherPath;
      },
      catch: (cause) =>
        new SikarugirError({
          message: `Wrapper launcher is missing or not executable at ${launcherPath}`,
          step: 'wrapper-readiness',
          cause,
        }),
    });
    return executable;
  });

const readEngineVersion = (
  wrapperPath: string
): Effect.Effect<string | undefined, SikarugirError> =>
  Effect.try({
    try: () => {
      const winePath = path.join(
        wrapperPath,
        'Contents',
        'SharedSupport',
        'wine'
      );
      if (!fs.existsSync(winePath)) return undefined;
      const preferredNames = [
        'version',
        'version.txt',
        'Version',
        'Version.txt',
      ];
      const discoveredNames = fs
        .readdirSync(winePath)
        .filter((name) => /version/i.test(name))
        .sort();
      for (const name of [
        ...new Set([...preferredNames, ...discoveredNames]),
      ]) {
        const versionPath = path.join(winePath, name);
        if (!fs.existsSync(versionPath) || !fs.statSync(versionPath).isFile()) {
          continue;
        }
        const version = fs.readFileSync(versionPath, 'utf8').trim();
        if (version) return version;
      }
      return undefined;
    },
    catch: (cause) =>
      new SikarugirError({
        message: 'Could not read the wrapper engine version',
        step: 'wrapper-readiness',
        cause,
      }),
  });

const inspectWrapper = (
  configuration: SikarugirRuntimeConfiguration
): Effect.Effect<ResolvedWrapper, SikarugirError> =>
  Effect.gen(function* () {
    const wrapperPath = path.resolve(configuration.wrapperPath);
    if (!fs.existsSync(wrapperPath)) {
      return yield* Effect.fail(
        new SikarugirError({
          message: `Sikarugir wrapper does not exist at ${wrapperPath}`,
          step: 'wrapper-readiness',
        })
      );
    }
    const launcherPath = yield* readLauncherPath(wrapperPath);
    const prefixPath = path.join(
      wrapperPath,
      'Contents',
      'SharedSupport',
      'prefix'
    );
    return {
      configuration,
      wrapperPath,
      launcherPath,
      prefixPath,
      launcher: makeSikarugirLauncher(launcherPath),
    };
  });

const resolveWrapper = (): Effect.Effect<
  ResolvedWrapper,
  ConfigError | PlatformError | SikarugirError
> =>
  Effect.gen(function* () {
    yield* ensureDarwin();
    return yield* inspectWrapper(yield* readSikarugirRuntimeConfiguration());
  });

const listSteamAccountIds = (steamRootPath: string): readonly string[] => {
  const userdataPath = path.join(steamRootPath, 'userdata');
  if (!fs.existsSync(userdataPath)) return [];
  return fs
    .readdirSync(userdataPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name !== '0' && /^\d+$/.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true })
    );
};

const withSteamRepository = <A, E>(
  steamRootPath: string,
  operation: Effect.Effect<A, E, SteamRepository>
): Effect.Effect<A, E> =>
  operation.pipe(Effect.provide(SteamRepositoryLive([steamRootPath])));

const chooseSteamLocation = (
  repository: Context.Tag.Service<SteamRepository>,
  configuration: SikarugirRuntimeConfiguration
): Effect.Effect<SteamLocation, SteamRepositoryError | SikarugirError> =>
  Effect.gen(function* () {
    const locations = yield* repository.locateAll;
    const configured = configuration.steamAccountId
      ? locations.find(
          (location) => location.user.accountId === configuration.steamAccountId
        )
      : undefined;
    if (configured) return configured;
    if (locations.length === 1) return locations[0];
    return yield* Effect.fail(
      new SikarugirError({
        message:
          locations.length === 0
            ? 'Windows Steam login is required before editing shortcuts'
            : 'Select a Windows Steam account before editing shortcuts',
        step: 'steam-account-selection',
      })
    );
  });

const readWindowsSteamRunning = (): Effect.Effect<boolean, SikarugirError> =>
  executeAbsolute(
    '/bin/ps',
    ['-ax', '-o', 'command='],
    'steam-stop-confirmation'
  ).pipe(
    Effect.map((processList) =>
      processList
        .split(/\r?\n/)
        .some((command) => /(?:^|[\\/])steam\.exe(?:\s|$)/i.test(command))
    )
  );

const waitForWindowsSteamExit = (): Effect.Effect<void, SikarugirError> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      if (!(yield* readWindowsSteamRunning())) return;
      yield* Effect.sleep('250 millis');
    }
    return yield* Effect.fail(
      new SikarugirError({
        message: 'Timed out waiting for Windows Steam to stop',
        step: 'steam-stop-confirmation',
      })
    );
  });

const withStoppedSteam = <A, E>(
  wrapper: ResolvedWrapper,
  operation: Effect.Effect<A, E>
): Effect.Effect<A, E | SikarugirError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const wasRunning = yield* restore(readWindowsSteamRunning());
      yield* restore(
        wrapper.launcher.quit.pipe(Effect.andThen(waitForWindowsSteamExit()))
      );
      const result = yield* Effect.exit(restore(operation));
      // Only bring Steam back if the user had it open before the mutation.
      const restart = wasRunning
        ? yield* Effect.exit(wrapper.launcher.run(WINDOWS_STEAM_EXECUTABLE))
        : undefined;
      if (result._tag === 'Failure')
        return yield* Effect.failCause(result.cause);
      if (restart !== undefined && restart._tag === 'Failure') {
        return yield* Effect.failCause(restart.cause);
      }
      return result.value;
    })
  );

const windowsPathFromPrefix = (
  prefixPath: string,
  macOsPath: string
): Effect.Effect<string, SikarugirError> =>
  Effect.try({
    try: () => {
      if (!path.isAbsolute(macOsPath)) {
        throw new Error('Path must be absolute');
      }
      const canonicalPath = fs.realpathSync.native(macOsPath);
      const dosDevicesPath = path.join(prefixPath, 'dosdevices');
      const mappings = fs
        .readdirSync(dosDevicesPath, { withFileTypes: true })
        .filter((entry) => /^[a-z]:$/i.test(entry.name))
        .flatMap((entry) => {
          const mappingPath = path.join(dosDevicesPath, entry.name);
          try {
            // Wine drive symlinks must be resolved before selecting a prefix.
            const target = fs.realpathSync.native(mappingPath);
            const matches =
              canonicalPath === target ||
              canonicalPath.startsWith(
                target === path.parse(target).root
                  ? target
                  : `${target}${path.sep}`
              );
            return matches ? [{ drive: entry.name[0], target }] : [];
          } catch {
            return [];
          }
        })
        .sort((left, right) => right.target.length - left.target.length);
      const mapping = mappings[0];
      if (!mapping) {
        throw new Error(`No Wine drive maps ${canonicalPath}`);
      }
      const relativePath = path.relative(mapping.target, canonicalPath);
      return `${mapping.drive.toUpperCase()}:\\${relativePath
        .split(path.sep)
        .filter(Boolean)
        .join('\\')}`;
    },
    catch: (cause) =>
      new SikarugirError({
        message: `Could not convert ${macOsPath} to a Wine-visible path`,
        step: 'wine-path-conversion',
        cause,
      }),
  });

export class SikarugirRuntime extends Context.Tag('SikarugirRuntime')<
  SikarugirRuntime,
  {
    readonly readConfiguration: Effect.Effect<
      SikarugirRuntimeConfiguration,
      ConfigError
    >;
    readonly writeConfiguration: (
      configuration: SikarugirRuntimeConfiguration
    ) => Effect.Effect<SikarugirRuntimeConfiguration, ConfigError>;
    readonly readiness: Effect.Effect<
      SikarugirWrapperReadiness,
      ConfigError | PlatformError
    >;
    readonly setupState: Effect.Effect<
      SikarugirSetupState,
      SikarugirRuntimeError
    >;
    readonly refreshEngineVersion: Effect.Effect<
      SikarugirRuntimeConfiguration,
      ConfigError | PlatformError | SikarugirError
    >;
    readonly createPrefix: (
      noRegistries?: boolean
    ) => Effect.Effect<void, ConfigError | PlatformError | SikarugirError>;
    readonly installSteam: (
      installerPath: string,
      flags?: readonly string[]
    ) => Effect.Effect<void, ConfigError | PlatformError | SikarugirError>;
    readonly reconcileWinetricks: (
      addonVerbs: readonly (readonly string[])[]
    ) => Effect.Effect<SikarugirWinetricksResult, SikarugirRuntimeError>;
    readonly repairWinetrick: (
      verb: string
    ) => Effect.Effect<SikarugirWinetricksResult, SikarugirRuntimeError>;
    readonly forceReinstallWinetrick: (
      verb: string
    ) => Effect.Effect<SikarugirWinetricksResult, SikarugirRuntimeError>;
    readonly toWindowsPath: (
      macOsPath: string
    ) => Effect.Effect<string, ConfigError | PlatformError | SikarugirError>;
    readonly lookupShortcut: (
      input: SikarugirShortcutInput
    ) => Effect.Effect<SteamShortcut | undefined, SikarugirRuntimeError>;
    readonly upsertShortcut: (
      input: SikarugirShortcutInput
    ) => Effect.Effect<SikarugirShortcutMutationResult, SikarugirRuntimeError>;
    readonly removeShortcut: (
      input: SikarugirShortcutInput
    ) => Effect.Effect<SikarugirShortcutMutationResult, SikarugirRuntimeError>;
    readonly launchSteam: (
      game?: Pick<SikarugirGameConfiguration, 'steamLaunchId'>
    ) => Effect.Effect<void, ConfigError | PlatformError | SikarugirError>;
    readonly updateWrapper: <A, E, R>(
      update: (wrapperPath: string) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | ConfigError | PlatformError | SikarugirError, R>;
  }
>() {}

export const SikarugirRuntimeLive: Layer.Layer<SikarugirRuntime> =
  Layer.succeed(SikarugirRuntime, {
    readConfiguration: readSikarugirRuntimeConfiguration(),
    // Serialized so config writes cannot race locked mutations that also
    // read/write the configuration (e.g. refreshEngineVersion).
    writeConfiguration: (configuration) =>
      runtimeMutationLock.withPermits(1)(
        writeSikarugirRuntimeConfiguration(configuration)
      ),
    readiness: Effect.gen(function* () {
      yield* ensureDarwin();
      const configuration = yield* readSikarugirRuntimeConfiguration();
      if (!fs.existsSync(configuration.wrapperPath)) {
        return {
          ready: false as const,
          reason: 'wrapper-missing' as const,
          wrapperPath: configuration.wrapperPath,
          message: `Sikarugir wrapper does not exist at ${configuration.wrapperPath}`,
        };
      }
      const inspected = yield* Effect.either(inspectWrapper(configuration));
      if (inspected._tag === 'Left') {
        return {
          ready: false as const,
          reason: 'wrapper-invalid' as const,
          wrapperPath: configuration.wrapperPath,
          message: inspected.left.message,
        };
      }
      const detectedEngineVersion = yield* readEngineVersion(
        configuration.wrapperPath
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      return {
        ready: true as const,
        wrapperPath: inspected.right.wrapperPath,
        launcherPath: inspected.right.launcherPath,
        prefixPath: inspected.right.prefixPath,
        configuredTemplateVersion: configuration.templateVersion,
        configuredEngineVersion: configuration.engineVersion,
        detectedEngineVersion,
      };
    }),
    setupState: Effect.gen(function* () {
      yield* ensureDarwin();
      const configuration = yield* readSikarugirRuntimeConfiguration();
      const inspected = yield* Effect.either(inspectWrapper(configuration));
      if (inspected._tag === 'Left') {
        return {
          state: 'wrapper-missing' as const,
          readiness: {
            ready: false as const,
            reason: fs.existsSync(configuration.wrapperPath)
              ? ('wrapper-invalid' as const)
              : ('wrapper-missing' as const),
            wrapperPath: configuration.wrapperPath,
            message: inspected.left.message,
          },
        };
      }
      if (
        !fs.existsSync(inspected.right.prefixPath) ||
        !fs.existsSync(path.join(inspected.right.prefixPath, 'drive_c'))
      ) {
        return { state: 'prefix-missing' as const };
      }
      if (!fs.existsSync(path.join(configuration.steamRootPath, 'steam.exe'))) {
        return { state: 'steam-not-installed' as const };
      }
      const steamAccountIds = yield* Effect.try({
        try: () => listSteamAccountIds(configuration.steamRootPath),
        catch: (cause) =>
          new SikarugirError({
            message: 'Could not inspect Windows Steam accounts',
            step: 'steam-login-detection',
            cause,
          }),
      });
      if (steamAccountIds.length === 0) {
        return { state: 'steam-login-required' as const };
      }
      const configuredAccount = configuration.steamAccountId;
      const selectedSteamAccountId =
        configuredAccount && steamAccountIds.includes(configuredAccount)
          ? configuredAccount
          : steamAccountIds.length === 1
            ? steamAccountIds[0]
            : undefined;
      return {
        state: 'ready' as const,
        steamAccountIds,
        selectedSteamAccountId,
        steamAccountSelectionRequired: selectedSteamAccountId === undefined,
      };
    }),
    refreshEngineVersion: runtimeMutationLock.withPermits(1)(
      Effect.gen(function* () {
        const wrapper = yield* resolveWrapper();
        const engineVersion = yield* readEngineVersion(wrapper.wrapperPath);
        return yield* writeSikarugirRuntimeConfiguration({
          ...wrapper.configuration,
          engineVersion: engineVersion ?? wrapper.configuration.engineVersion,
        });
      })
    ),
    createPrefix: (noRegistries = false) =>
      runtimeMutationLock.withPermits(1)(
        resolveWrapper().pipe(
          Effect.flatMap((wrapper) =>
            wrapper.launcher.createPrefix(noRegistries)
          )
        )
      ),
    installSteam: (installerPath, flags = []) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const absoluteInstallerPath = path.resolve(installerPath);
          if (
            !path.isAbsolute(installerPath) ||
            !fs.existsSync(absoluteInstallerPath)
          ) {
            return yield* Effect.fail(
              new SikarugirError({
                message: `Steam installer does not exist at ${installerPath}`,
                step: 'steam-install',
              })
            );
          }
          yield* wrapper.launcher.runStartExecutable(
            absoluteInstallerPath,
            flags
          );
        })
      ),
    reconcileWinetricks: (addonVerbs) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const reconciliation = yield* reconcileWinetricksVerbs(
            wrapper.prefixPath,
            addonVerbs
          );
          for (const verb of reconciliation.missing) {
            yield* wrapper.launcher.winetricks(verb);
          }
          const finalState = yield* reconcileWinetricksVerbs(
            wrapper.prefixPath,
            [reconciliation.requested]
          );
          return { ...finalState, attempted: reconciliation.missing };
        })
      ),
    repairWinetrick: (verb) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const [normalizedVerb] = yield* normalizeWinetricksVerbs([[verb]]);
          yield* wrapper.launcher.winetricks(normalizedVerb);
          const finalState = yield* reconcileWinetricksVerbs(
            wrapper.prefixPath,
            [[normalizedVerb]]
          );
          return { ...finalState, attempted: [normalizedVerb] };
        })
      ),
    forceReinstallWinetrick: (verb) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const [normalizedVerb] = yield* normalizeWinetricksVerbs([[verb]]);
          yield* wrapper.launcher.winetricks(normalizedVerb, true);
          const finalState = yield* reconcileWinetricksVerbs(
            wrapper.prefixPath,
            [[normalizedVerb]]
          );
          return { ...finalState, attempted: [normalizedVerb] };
        })
      ),
    toWindowsPath: (macOsPath) =>
      resolveWrapper().pipe(
        Effect.flatMap((wrapper) =>
          windowsPathFromPrefix(wrapper.prefixPath, macOsPath)
        )
      ),
    lookupShortcut: (input) =>
      Effect.gen(function* () {
        const wrapper = yield* resolveWrapper();
        const executable = yield* windowsPathFromPrefix(
          wrapper.prefixPath,
          input.executablePath
        );
        return yield* withSteamRepository(
          wrapper.configuration.steamRootPath,
          Effect.gen(function* () {
            const repository = yield* SteamRepository;
            const location = yield* chooseSteamLocation(
              repository,
              wrapper.configuration
            );
            const document = yield* repository.readShortcuts(location);
            return yield* Effect.try({
              try: () =>
                findOwnedShortcut(
                  readShortcuts(serializeBinaryVdf(document.root)).shortcuts,
                  {
                    gameId: input.gameId,
                    knownAppId: input.knownAppId,
                    executable,
                    legacyNames: [input.appName],
                  }
                ),
              catch: (cause) =>
                cause instanceof SteamShortcutConflictError
                  ? cause
                  : new SteamVdfParseError({
                      message: 'Could not inspect Windows Steam shortcuts',
                      path: document.shortcutsPath,
                      cause,
                    }),
            });
          })
        );
      }),
    upsertShortcut: (input) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const executable = yield* windowsPathFromPrefix(
            wrapper.prefixPath,
            input.executablePath
          );
          const startDir = yield* windowsPathFromPrefix(
            wrapper.prefixPath,
            input.workingDirectory
          );
          return yield* withSteamRepository(
            wrapper.configuration.steamRootPath,
            Effect.gen(function* () {
              const repository = yield* SteamRepository;
              const location = yield* chooseSteamLocation(
                repository,
                wrapper.configuration
              );
              return yield* withStoppedSteam(
                wrapper,
                repository.modifyShortcuts(
                  location,
                  ({ root, shortcutsPath, commit }) =>
                    Effect.gen(function* () {
                      const result = yield* Effect.try({
                        try: () =>
                          upsertShortcut(root, {
                            gameId: input.gameId,
                            knownAppId: input.knownAppId,
                            executable,
                            legacyNames: [input.appName],
                            appName: input.appName,
                            startDir,
                            launchOptions: [
                              input.launchOptions?.trim(),
                              `--game-id=${input.gameId}`,
                            ]
                              .filter(Boolean)
                              .join(' '),
                            icon: input.icon,
                            tags: ['OpenGameInstaller'],
                          }),
                        catch: (cause) =>
                          cause instanceof SteamShortcutConflictError
                            ? cause
                            : new SteamVdfParseError({
                                message:
                                  'Could not update Windows Steam shortcuts',
                                path: shortcutsPath,
                                cause,
                              }),
                      });
                      yield* commit();
                      return {
                        appId: result.appId,
                        created: result.created,
                      };
                    })
                )
              );
            })
          );
        })
      ),
    removeShortcut: (input) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          const wrapper = yield* resolveWrapper();
          const executable = yield* windowsPathFromPrefix(
            wrapper.prefixPath,
            input.executablePath
          );
          return yield* withSteamRepository(
            wrapper.configuration.steamRootPath,
            Effect.gen(function* () {
              const repository = yield* SteamRepository;
              const location = yield* chooseSteamLocation(
                repository,
                wrapper.configuration
              );
              return yield* withStoppedSteam(
                wrapper,
                repository.modifyShortcuts(
                  location,
                  ({ root, shortcutsPath, commit }) =>
                    Effect.gen(function* () {
                      const result = yield* Effect.try({
                        try: () =>
                          removeOwnedShortcut(root, {
                            gameId: input.gameId,
                            knownAppId: input.knownAppId,
                            executable,
                            legacyNames: [input.appName],
                          }),
                        catch: (cause) =>
                          cause instanceof SteamShortcutConflictError
                            ? cause
                            : new SteamVdfParseError({
                                message:
                                  'Could not update Windows Steam shortcuts',
                                path: shortcutsPath,
                                cause,
                              }),
                      });
                      if (result.removed) yield* commit();
                      return { appId: result.appId, removed: result.removed };
                    })
                )
              );
            })
          );
        })
      ),
    launchSteam: (game) =>
      runtimeMutationLock.withPermits(1)(
        resolveWrapper().pipe(
          Effect.flatMap((wrapper) => {
            const flags = game?.steamLaunchId
              ? ['-applaunch', game.steamLaunchId]
              : [];
            // Launcher spawn success is observable; selected-game exit is not yet.
            return wrapper.launcher.run(WINDOWS_STEAM_EXECUTABLE, flags);
          })
        )
      ),
    updateWrapper: (update) =>
      runtimeMutationLock.withPermits(1)(
        Effect.gen(function* () {
          yield* ensureDarwin();
          const configuration = yield* readSikarugirRuntimeConfiguration();
          return yield* update(configuration.wrapperPath);
        })
      ),
  });
