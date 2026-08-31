import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  ConfigError,
  FileSystemError,
  formatError,
  HttpError,
  PlatformError,
  SikarugirError,
} from '@ogi-sdk/errors';
import axios from 'axios';
import { Effect } from 'effect';
import { executeAbsolute } from './exec.js';
import { makeSikarugirLauncher } from './launcher.js';
import {
  readSikarugirRuntimeConfiguration,
  type SikarugirRuntimeConfiguration,
  withRuntimeMutationLock,
  writeSikarugirRuntimeConfiguration,
} from './runtime.js';

/**
 * Pinned official artifacts. Only the Sikarugir-App GitHub organization is
 * used: upstream warns that sikarugir.com is unaffiliated and may serve
 * malware. Digests were verified against the GitHub release assets.
 */
export const TEMPLATE_VERSION = 'Template-1.0.11';
export const TEMPLATE_URL =
  'https://github.com/Sikarugir-App/Wrapper/releases/download/v1.0/Template-1.0.11.tar.xz';
export const TEMPLATE_SHA256 =
  '9fa15479e7ff6abd99c1d07be285fb95f41fc6991586502427152b1f7d6ccb8a';
export const ENGINE_VERSION = 'WS12WineSikarugir10.0_6';
export const ENGINE_URL =
  'https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir10.0_6.tar.xz';
export const ENGINE_SHA256 =
  '9da7ee0cbf386522f3a9906943726d9c3c125dbbd9ab120e3cde80e88d6091b2';

const WINDOWS_STEAM_EXECUTABLE = 'C:\\Program Files (x86)\\Steam\\steam.exe';
const WRAPPER_BUNDLE_NAME = 'CFBundleName';
const WRAPPER_BUNDLE_IDENTIFIER = 'com.opengameinstaller.sikarugir.steam';

export type ProvisionProgress = (stage: string, progress: number) => void;

export type SikarugirProvisionError =
  | ConfigError
  | FileSystemError
  | HttpError
  | PlatformError
  | SikarugirError;

export interface SikarugirProvisionResult {
  readonly wrapperPath: string;
  readonly templateVersion: string;
  readonly engineVersion: string;
  /** True when a ready wrapper already existed and nothing was assembled. */
  readonly alreadyProvisioned: boolean;
}

const fileSystemAttempt = <A>(
  operation: () => Promise<A>,
  targetPath: string
): Effect.Effect<A, FileSystemError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new FileSystemError({
        message: formatError(cause),
        path: targetPath,
        cause,
      }),
  });

/**
 * Stream an artifact to disk while hashing it in the same pass, so progress
 * reporting and digest verification do not require buffering the archive.
 */
const downloadVerified = (
  url: string,
  destination: string,
  expectedSha256: string,
  stage: string,
  fromProgress: number,
  toProgress: number,
  report: ProvisionProgress
): Effect.Effect<void, HttpError | FileSystemError | SikarugirError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        axios.get<NodeJS.ReadableStream>(url, {
          responseType: 'stream',
          timeout: 60_000,
        }),
      catch: (cause: unknown) =>
        new HttpError({
          message: axios.isAxiosError(cause)
            ? cause.message
            : formatError(cause),
          statusCode: axios.isAxiosError(cause)
            ? (cause.response?.status ?? 0)
            : 0,
          url,
        }),
    });
    const totalBytes = Number.parseInt(
      String(response.headers['content-length'] ?? '0'),
      10
    );
    const hash = createHash('sha256');
    let receivedBytes = 0;
    let lastReported = fromProgress;
    response.data.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      receivedBytes += chunk.length;
      if (totalBytes <= 0) return;
      const value =
        fromProgress +
        (toProgress - fromProgress) * Math.min(receivedBytes / totalBytes, 1);
      if (value - lastReported < 1) return;
      lastReported = value;
      report(stage, value);
    });
    yield* fileSystemAttempt(
      () => pipeline(response.data, fs.createWriteStream(destination)),
      destination
    );
    const digest = hash.digest('hex');
    if (digest !== expectedSha256) {
      return yield* Effect.fail(
        new SikarugirError({
          message: `${path.basename(destination)} failed verification: expected SHA-256 ${expectedSha256}, got ${digest}`,
          step: 'artifact-verification',
        })
      );
    }
    report(stage, toProgress);
  });

const extractArchive = (
  archivePath: string,
  destination: string
): Effect.Effect<void, SikarugirError> =>
  executeAbsolute(
    '/usr/bin/tar',
    ['-xJf', archivePath, '-C', destination],
    'artifact-extraction'
  ).pipe(Effect.asVoid);

const listDirectories = (
  directory: string
): Effect.Effect<readonly string[], FileSystemError> =>
  fileSystemAttempt(
    async () =>
      (await fsp.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(directory, entry.name)),
    directory
  );

/** The template archive contains exactly one app bundle at its root. */
const locateWrapperBundle = (
  extractedPath: string
): Effect.Effect<string, FileSystemError | SikarugirError> =>
  Effect.gen(function* () {
    const candidates = yield* listDirectories(extractedPath);
    const bundle = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'Contents', 'Info.plist'))
    );
    if (!bundle) {
      return yield* Effect.fail(
        new SikarugirError({
          message:
            'The Sikarugir template archive does not contain an app bundle with Contents/Info.plist',
          step: 'template-assembly',
        })
      );
    }
    return bundle;
  });

/**
 * Engine archives have shipped both as a single payload directory (e.g.
 * `wswine.bundle`) and as loose engine contents, so the payload root is
 * detected rather than assumed before it is normalized into SharedSupport/wine.
 */
const locateEnginePayload = (
  extractedPath: string
): Effect.Effect<string, FileSystemError | SikarugirError> =>
  Effect.gen(function* () {
    const isPayload = (candidate: string): boolean => {
      if (
        fs.existsSync(path.join(candidate, 'bin')) ||
        fs.existsSync(path.join(candidate, 'lib'))
      ) {
        return true;
      }
      try {
        return fs
          .readdirSync(candidate)
          .some((name) => /^version(\.txt)?$/i.test(name));
      } catch {
        return false;
      }
    };
    if (isPayload(extractedPath)) return extractedPath;
    const candidates = yield* listDirectories(extractedPath);
    const payload = candidates.find(isPayload) ?? candidates[0];
    if (!payload) {
      return yield* Effect.fail(
        new SikarugirError({
          message: 'The Sikarugir engine archive is empty',
          step: 'engine-assembly',
        })
      );
    }
    return payload;
  });

const replacePlistString = (
  infoPlistPath: string,
  key: string,
  value: string
): Effect.Effect<void, SikarugirError> =>
  executeAbsolute(
    '/usr/bin/plutil',
    ['-replace', key, '-string', value, infoPlistPath],
    'wrapper-configuration'
  ).pipe(Effect.asVoid);

/** Rename first; fall back to a copy when the staging dir is on another device. */
const installBundle = (
  sourcePath: string,
  wrapperPath: string
): Effect.Effect<void, FileSystemError | SikarugirError> =>
  Effect.gen(function* () {
    yield* fileSystemAttempt(
      () => fsp.mkdir(path.dirname(wrapperPath), { recursive: true }),
      path.dirname(wrapperPath)
    );
    const renamed = yield* Effect.either(
      fileSystemAttempt(() => fsp.rename(sourcePath, wrapperPath), wrapperPath)
    );
    if (renamed._tag === 'Right') return;
    yield* executeAbsolute(
      '/bin/cp',
      ['-R', sourcePath, wrapperPath],
      'wrapper-install'
    );
    yield* fileSystemAttempt(
      () => fsp.rm(sourcePath, { recursive: true, force: true }),
      sourcePath
    );
  });

export const provisionWrapper = (
  report: ProvisionProgress
): Effect.Effect<SikarugirProvisionResult, SikarugirProvisionError> =>
  Effect.gen(function* () {
    if (process.platform !== 'darwin') {
      return yield* Effect.fail(
        new PlatformError({
          message: 'Sikarugir wrapper provisioning is only supported on macOS',
          platform: process.platform,
        })
      );
    }
    const configuration = yield* readSikarugirRuntimeConfiguration();
    const wrapperPath = configuration.wrapperPath;
    if (fs.existsSync(wrapperPath)) {
      return {
        wrapperPath,
        templateVersion: configuration.templateVersion,
        engineVersion: configuration.engineVersion,
        alreadyProvisioned: true,
      };
    }

    const temporaryDirectory = yield* fileSystemAttempt(
      () => fsp.mkdtemp(path.join(os.tmpdir(), 'ogi-sikarugir-')),
      os.tmpdir()
    );
    return yield* Effect.gen(function* () {
      const templateArchive = path.join(temporaryDirectory, 'template.tar.xz');
      const engineArchive = path.join(temporaryDirectory, 'engine.tar.xz');
      const templateRoot = path.join(temporaryDirectory, 'template');
      const engineRoot = path.join(temporaryDirectory, 'engine');

      report('Downloading the Sikarugir wrapper template', 0);
      yield* downloadVerified(
        TEMPLATE_URL,
        templateArchive,
        TEMPLATE_SHA256,
        'Downloading the Sikarugir wrapper template',
        0,
        25,
        report
      );
      report('Downloading the Sikarugir Wine engine', 25);
      yield* downloadVerified(
        ENGINE_URL,
        engineArchive,
        ENGINE_SHA256,
        'Downloading the Sikarugir Wine engine',
        25,
        60,
        report
      );

      report('Extracting the wrapper template', 62);
      yield* fileSystemAttempt(
        () => fsp.mkdir(templateRoot, { recursive: true }),
        templateRoot
      );
      yield* extractArchive(templateArchive, templateRoot);
      const bundlePath = yield* locateWrapperBundle(templateRoot);

      report('Installing the Wine engine', 72);
      yield* fileSystemAttempt(
        () => fsp.mkdir(engineRoot, { recursive: true }),
        engineRoot
      );
      yield* extractArchive(engineArchive, engineRoot);
      const enginePayload = yield* locateEnginePayload(engineRoot);
      const winePath = path.join(
        bundlePath,
        'Contents',
        'SharedSupport',
        'wine'
      );
      yield* fileSystemAttempt(
        () => fsp.rm(winePath, { recursive: true, force: true }),
        winePath
      );
      yield* fileSystemAttempt(
        () => fsp.mkdir(path.dirname(winePath), { recursive: true }),
        path.dirname(winePath)
      );
      yield* fileSystemAttempt(
        () => fsp.rename(enginePayload, winePath),
        winePath
      );

      report('Configuring the wrapper', 80);
      const infoPlistPath = path.join(bundlePath, 'Contents', 'Info.plist');
      // D3DMETAL is deliberately left untouched: its license forbids
      // commercial ports, so it must stay a deliberate user choice.
      yield* replacePlistString(infoPlistPath, WRAPPER_BUNDLE_NAME, 'Steam');
      yield* replacePlistString(
        infoPlistPath,
        'CFBundleIdentifier',
        WRAPPER_BUNDLE_IDENTIFIER
      );
      yield* replacePlistString(
        infoPlistPath,
        'Program Name and Path',
        WINDOWS_STEAM_EXECUTABLE
      );

      report('Installing the wrapper', 88);
      // The final move and the configuration write are serialized against
      // every other prefix mutation.
      const installed = yield* withRuntimeMutationLock(
        Effect.gen(function* () {
          yield* installBundle(bundlePath, wrapperPath);
          // Anything that fails after the move must take the bundle with it,
          // or readiness would latch on 'wrapper-invalid' and never re-provision.
          return yield* Effect.gen(function* () {
            // Mirrors the official Homebrew cask, which also strips quarantine
            // and ad-hoc signs the app it installs.
            yield* executeAbsolute(
              '/usr/bin/xattr',
              ['-dr', 'com.apple.quarantine', wrapperPath],
              'wrapper-install'
            );
            yield* executeAbsolute(
              '/usr/bin/codesign',
              ['--force', '--deep', '--sign', '-', wrapperPath],
              'wrapper-install'
            );

            report('Validating the wrapper', 94);
            yield* validateWrapper(wrapperPath);

            const updated: SikarugirRuntimeConfiguration = {
              ...configuration,
              wrapperPath,
              templateVersion: TEMPLATE_VERSION,
              engineVersion: ENGINE_VERSION,
            };
            return yield* writeSikarugirRuntimeConfiguration(updated);
          }).pipe(
            Effect.tapError(() =>
              fileSystemAttempt(
                () => fsp.rm(wrapperPath, { recursive: true, force: true }),
                wrapperPath
              ).pipe(Effect.ignore)
            )
          );
        })
      );
      report('Windows-game support is ready', 100);
      return {
        wrapperPath: installed.wrapperPath,
        templateVersion: installed.templateVersion,
        engineVersion: installed.engineVersion,
        alreadyProvisioned: false,
      };
    }).pipe(
      Effect.ensuring(
        fileSystemAttempt(
          () => fsp.rm(temporaryDirectory, { recursive: true, force: true }),
          temporaryDirectory
        ).pipe(Effect.ignore)
      )
    );
  });

/** Prove the assembled bundle exposes a usable launcher before adopting it. */
const validateWrapper = (
  wrapperPath: string
): Effect.Effect<void, SikarugirError> =>
  Effect.gen(function* () {
    const executableName = (yield* executeAbsolute(
      '/usr/bin/plutil',
      [
        '-extract',
        'CFBundleExecutable',
        'raw',
        '-o',
        '-',
        path.join(wrapperPath, 'Contents', 'Info.plist'),
      ],
      'wrapper-validation'
    )).trim();
    const macOsPath = path.resolve(wrapperPath, 'Contents', 'MacOS');
    const launcherPath = path.resolve(macOsPath, executableName);
    if (
      !executableName ||
      !launcherPath.startsWith(`${macOsPath}${path.sep}`) ||
      !fs.existsSync(launcherPath)
    ) {
      return yield* Effect.fail(
        new SikarugirError({
          message: `The assembled wrapper has no usable launcher at ${launcherPath}`,
          step: 'wrapper-validation',
        })
      );
    }
    yield* makeSikarugirLauncher(launcherPath).probeCapabilities;
  });
