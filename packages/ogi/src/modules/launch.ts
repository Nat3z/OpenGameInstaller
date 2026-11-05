import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Command, type CommandExecutor, FileSystem } from '@effect/platform';
import type { PlatformError } from '@effect/platform/Error';
import {
  type ChannelRelease,
  downloadAsset,
  fetchRelease,
  fetchReleases,
  formatBytes,
  platformAsset,
  type ReleaseChannel,
  type ReleaseError,
} from '@ogi/update-channel';
import { Console, Data, Effect, Stream } from 'effect';

export class LaunchError extends Data.TaggedError('LaunchError')<{
  readonly message: string;
}> {}

type Failure = LaunchError | ReleaseError | PlatformError;
type Services = FileSystem.FileSystem | CommandExecutor.CommandExecutor;

const EXECUTABLE: string =
  process.platform === 'win32'
    ? 'OpenGameInstaller.exe'
    : process.platform === 'darwin'
      ? join('OpenGameInstaller.app', 'Contents', 'MacOS', 'OpenGameInstaller')
      : 'OpenGameInstaller.AppImage';

/** The addon server a dev launch connects to instead of starting its own. */
export interface DevServer {
  port: number;
  secret: string;
}

/** Tag that local builds installed with `fromBuild` live under. */
export const LOCAL_TAG = 'local';

export interface LaunchTarget {
  /** A local build (electron-builder's zip or AppImage) to install and launch. */
  from?: string;
  /** A release tag to launch instead of the channel's newest. */
  version?: string;
  channel: ReleaseChannel;
  /** Skips the update check and launches the channel's installed build. */
  offline: boolean;
}

/** Prints download progress on one line, at most every 250ms. */
function progressPrinter(
  name: string
): (written: number, total?: number) => void {
  let last = 0;
  return (written, total) => {
    const now = Date.now();
    if (now - last < 250 && written !== total) return;
    last = now;
    const size = total
      ? `${formatBytes(written)} / ${formatBytes(total)}`
      : formatBytes(written);
    process.stdout.write(`\r\x1B[2KDownloading ${name} (${size})`);
    if (written === total) process.stdout.write('\n');
  };
}

/**
 * Downloads OpenGameInstaller releases into `<root>/<tag>` and launches them.
 * `<root>/<channel>.txt` records the newest tag installed for a channel, so
 * launches can fall back to it offline.
 */
export class LaunchTool {
  constructor(readonly root: string = join(homedir(), '.ogi', 'app')) {}

  private directory(tag: string): string {
    return join(this.root, tag);
  }

  private pointer(channel: ReleaseChannel): string {
    return join(this.root, `${channel}.txt`);
  }

  private supported(): Effect.Effect<void, LaunchError> {
    return ['win32', 'linux', 'darwin'].includes(process.platform)
      ? Effect.void
      : Effect.fail(
          new LaunchError({
            message: `OpenGameInstaller has no builds for ${process.platform}`,
          })
        );
  }

  isInstalled(
    tag: string
  ): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> {
    return Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.exists(join(this.directory(tag), EXECUTABLE))
    );
  }

  /** The newest tag installed for a channel, if any. */
  current(
    channel: ReleaseChannel
  ): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = this.pointer(channel);
      if (!(yield* fs.exists(path))) return undefined;
      const tag = (yield* fs.readFileString(path)).trim();
      return (yield* this.isInstalled(tag)) ? tag : undefined;
    });
  }

  /** Picks the build to launch: a local build, then a pinned version, then the channel's newest. */
  resolve(target: LaunchTarget): Effect.Effect<string, Failure, Services> {
    if (target.from) return this.fromBuild(target.from);
    if (target.version) return this.download(target.version);
    if (!target.offline) return this.latest(target.channel);
    return Effect.flatMap(this.current(target.channel), (tag) =>
      tag
        ? Effect.succeed(tag)
        : new LaunchError({
            message: `No ${target.channel} build installed`,
          })
    );
  }

  /** Downloads a release tag (`v4.3.4`, `4.3.4`, `nightly-<id>`, or an installed `local`), skipping it when already installed. */
  download(version: string): Effect.Effect<string, Failure, Services> {
    return Effect.gen(this, function* () {
      const tag =
        version === LOCAL_TAG ||
        version.startsWith('v') ||
        version.startsWith('nightly-')
          ? version
          : `v${version}`;
      if (yield* this.isInstalled(tag)) return tag;
      if (tag === LOCAL_TAG)
        return yield* new LaunchError({
          message: 'No local build installed, pass --from <build>',
        });
      // every nightly keeps its own release, so older ones stay fetchable by tag
      const release = yield* fetchRelease(tag);
      if (!release)
        return yield* new LaunchError({
          message: `No release found for ${tag}`,
        });
      return yield* this.install(release);
    });
  }

  /** Installs the newest release on a channel if it isn't already, returning its tag. */
  update(channel: ReleaseChannel): Effect.Effect<string, Failure, Services> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem.FileSystem;
      const [release] = yield* fetchReleases(channel, 'application');
      if (!release)
        return yield* new LaunchError({
          message: `No ${channel} releases found`,
        });
      const tag = yield* this.install(release);
      yield* fs.writeFileString(this.pointer(channel), tag);
      return tag;
    });
  }

  /** Updates a channel, falling back to its installed tag when the feed is unreachable. */
  latest(channel: ReleaseChannel): Effect.Effect<string, Failure, Services> {
    return this.update(channel).pipe(
      Effect.catchTag('ReleaseError', (error) =>
        Effect.gen(this, function* () {
          const tag = yield* this.current(channel);
          if (!tag) return yield* error;
          yield* Console.warn(`${error.message}\nUsing installed ${tag}.`);
          return tag;
        })
      )
    );
  }

  private install(
    release: ChannelRelease
  ): Effect.Effect<string, Failure, Services> {
    return Effect.gen(this, function* () {
      const tag = release.tag_name;
      if (yield* this.isInstalled(tag)) return tag;
      yield* this.supported();
      const asset = platformAsset(release, 'application');
      if (!asset)
        return yield* new LaunchError({
          message: `${tag} has no build for ${process.platform}`,
        });
      const progress = progressPrinter(`${tag} ${asset.name}`);
      return yield* this.stage(tag, asset.name, (archive) =>
        downloadAsset(asset, archive, {
          onProgress: ({ written, total }) => progress(written, total),
          onRetry: (attempt, attempts, error) =>
            console.warn(
              `\n${error.message}, retrying (${attempt}/${attempts})`
            ),
        })
      );
    });
  }

  /** Installs a local build as the `local` tag, replacing the previous one. */
  fromBuild(path: string): Effect.Effect<string, Failure, Services> {
    return Effect.gen(this, function* () {
      yield* this.supported();
      const fs = yield* FileSystem.FileSystem;
      return yield* this.stage(LOCAL_TAG, basename(path), (archive) =>
        fs.copyFile(path, archive)
      );
    });
  }

  /**
   * Fills a staging directory with an archive, unpacks it, then moves it into
   * place; failures leave nothing behind. Staging is per process, so two
   * installs of one tag can't delete each other's downloads.
   */
  private stage(
    tag: string,
    name: string,
    fetch: (archive: string) => Effect.Effect<void, Failure, Services>
  ): Effect.Effect<string, Failure, Services> {
    return Effect.flatMap(FileSystem.FileSystem, (fs) => {
      const staging = `${this.directory(tag)}.${process.pid}.download`;
      return this.unpack(tag, name, staging, fetch).pipe(
        Effect.onError(() =>
          Effect.ignore(fs.remove(staging, { recursive: true, force: true }))
        )
      );
    });
  }

  private unpack(
    tag: string,
    name: string,
    staging: string,
    fetch: (archive: string) => Effect.Effect<void, Failure, Services>
  ): Effect.Effect<string, Failure, Services> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem.FileSystem;
      const archive = join(staging, name);
      yield* fs.remove(staging, { recursive: true, force: true });
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* fetch(archive);

      if (process.platform === 'linux') {
        const executable = join(staging, EXECUTABLE);
        yield* fs.rename(archive, executable);
        yield* fs.chmod(executable, 0o755);
      } else {
        // Windows' bundled bsdtar extracts zips; ditto keeps the app bundle's symlinks intact.
        const [command, ...args] =
          process.platform === 'win32'
            ? ['tar', '-xf', archive, '-C', staging]
            : ['ditto', '-x', '-k', archive, staging];
        const code = yield* Command.exitCode(Command.make(command!, ...args));
        if (code !== 0)
          return yield* new LaunchError({
            message: `Failed to extract ${name} (${command} exited ${code})`,
          });
        yield* fs.remove(archive);
      }
      if (!(yield* fs.exists(join(staging, EXECUTABLE))))
        return yield* new LaunchError({
          message: `${name} doesn't contain ${EXECUTABLE}`,
        });

      // keep the old install until the new one is in place, so a failed
      // rename restores it instead of leaving nothing
      const target = this.directory(tag);
      const previous = `${target}.${process.pid}.old`;
      const replacing = yield* fs.exists(target);
      if (replacing) yield* fs.rename(target, previous);
      yield* fs
        .rename(staging, target)
        .pipe(
          Effect.tapError(() =>
            replacing ? Effect.ignore(fs.rename(previous, target)) : Effect.void
          )
        );
      if (replacing)
        yield* Effect.ignore(
          fs.remove(previous, { recursive: true, force: true })
        );
      return tag;
    });
  }

  /**
   * Runs an installed tag in the foreground and resolves with its exit code.
   * Output goes to the terminal unless an `output` handler takes it. A `dev`
   * server points the gui at that addon server, with its own data directory.
   */
  launch(
    tag: string,
    useServer: boolean = true,
    online: boolean = true,
    skipOOBE: boolean = false,
    dev?: DevServer,
    output?: (data: Uint8Array) => void
  ): Effect.Effect<number, LaunchError | PlatformError, Services> {
    return Effect.gen(this, function* () {
      yield* this.supported();
      if (!(yield* this.isInstalled(tag)))
        return yield* new LaunchError({ message: `${tag} is not installed` });
      // --no-sandbox lets the AppImage run without a setuid chrome-sandbox.
      const args = [`--online=${online}`];
      if (!useServer) args.push(`--no-server`);
      if (process.platform === 'linux') args.push('--no-sandbox');
      if (skipOOBE) args.push('--skip-oobe');
      let command = Command.make(`./${EXECUTABLE}`, ...args).pipe(
        Command.workingDirectory(this.directory(tag))
      );
      if (dev)
        command = command.pipe(
          Command.env({
            OGI_DIRECTORY: join(homedir(), '.ogi', 'dev'),
            OGI_ADDON_SERVER_PORT: String(dev.port),
            OGI_ADDON_SERVER_SECRET: dev.secret,
          })
        );

      if (!output)
        return yield* command.pipe(
          Command.stdin('inherit'),
          Command.stdout('inherit'),
          Command.stderr('inherit'),
          Command.exitCode
        );

      // closing the scope kills the gui if the launch is interrupted
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const gui = yield* Command.start(command);
          yield* Stream.merge(gui.stdout, gui.stderr).pipe(
            Stream.runForEach((data) => Effect.sync(() => output(data))),
            Effect.forkScoped
          );
          return yield* gui.exitCode;
        })
      );
    });
  }
}
