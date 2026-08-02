import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SteamNotFoundError,
  SteamUserNotFoundError,
  SteamVdfParseError,
  SteamVdfWriteError,
} from '@ogi/errors';
import { Context, Effect, Exit, Layer } from 'effect';
import { readShortcuts } from '@/electron/lib/steam-shortcuts.js';
import type { BinaryVdfObject } from '@/electron/lib/steam-vdf.js';
import {
  parseLoginUsers,
  serializeBinaryVdf,
} from '@/electron/lib/steam-vdf.js';

export interface SteamUser {
  accountId: string;
  steamId?: string;
  accountName?: string;
  personaName?: string;
  mostRecent: boolean;
  timestamp: number;
  userdataPath: string;
  shortcutsPath: string;
}

export interface SteamLocation {
  root: string;
  user: SteamUser;
  loginUsersPath: string;
}

export type SteamRepositoryError =
  | SteamNotFoundError
  | SteamUserNotFoundError
  | SteamVdfParseError
  | SteamVdfWriteError;

export interface SteamShortcutsTransaction {
  root: BinaryVdfObject;
  shortcutsPath: string;
  commit: (root?: BinaryVdfObject) => Effect.Effect<void, SteamVdfWriteError>;
  rollback: Effect.Effect<void, SteamVdfWriteError>;
}

export function getSteamCompatDataPath(root: string, appId?: number): string {
  const compatData = path.join(root, 'steamapps', 'compatdata');
  return appId === undefined
    ? compatData
    : path.join(compatData, String(appId));
}

export function findSteamCompatDataPath(
  appId?: number,
  candidates = getSteamRootCandidates()
): string | undefined {
  const root = candidates.find((candidate) =>
    fs.existsSync(getSteamCompatDataPath(candidate, appId))
  );
  return root ? getSteamCompatDataPath(root) : undefined;
}

export function getSteamRootCandidates(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const candidates =
    platform === 'win32'
      ? [
          process.env.STEAM_PATH,
          process.env.PROGRAMFILES_X86
            ? path.join(process.env.PROGRAMFILES_X86, 'Steam')
            : undefined,
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, 'Steam')
            : undefined,
        ]
      : platform === 'darwin'
        ? [path.join(home, 'Library/Application Support/Steam')]
        : [
            process.env.STEAM_PATH,
            path.join(home, '.steam/steam'),
            path.join(home, '.local/share/Steam'),
            path.join(
              home,
              '.var/app/com.valvesoftware.Steam/.local/share/Steam'
            ),
          ];
  return [
    ...new Set(
      candidates.filter((candidate): candidate is string => Boolean(candidate))
    ),
  ];
}

const listSteamUsersSync = (root: string): SteamUser[] => {
  const userdataRoot = path.join(root, 'userdata');
  if (!fs.existsSync(userdataRoot)) return [];
  const accountIds = fs
    .readdirSync(userdataRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name !== '0' && /^\d+$/.test(entry.name)
    )
    .map((entry) => entry.name);
  if (accountIds.length === 0) return [];

  const loginUsersPath = path.join(root, 'config/loginusers.vdf');
  let loginUsers: Omit<SteamUser, 'userdataPath' | 'shortcutsPath'>[] = [];
  if (fs.existsSync(loginUsersPath)) {
    try {
      loginUsers = parseLoginUsers(fs.readFileSync(loginUsersPath, 'utf8'));
    } catch (cause) {
      throw new SteamVdfParseError({
        message: `Could not parse ${loginUsersPath}`,
        path: loginUsersPath,
        cause,
      });
    }
  }

  const knownUsers = new Map(
    loginUsers.map((user) => [user.accountId, user] as const)
  );
  return accountIds
    .map((accountId) => {
      const user = knownUsers.get(accountId) ?? {
        accountId,
        mostRecent: false,
        timestamp: Math.floor(
          fs.statSync(path.join(userdataRoot, accountId)).mtimeMs / 1_000
        ),
      };
      const userdataPath = path.join(userdataRoot, accountId);
      return {
        ...user,
        userdataPath,
        shortcutsPath: path.join(userdataPath, 'config/shortcuts.vdf'),
      };
    })
    .sort(
      (left, right) =>
        Number(right.mostRecent) - Number(left.mostRecent) ||
        right.timestamp - left.timestamp ||
        right.accountId.localeCompare(left.accountId, undefined, {
          numeric: true,
        })
    );
};

const selectSteamUserSync = (root: string): SteamUser | undefined =>
  listSteamUsersSync(root)[0];

export function selectSteamUser(
  root: string
): Effect.Effect<SteamUser, SteamUserNotFoundError | SteamVdfParseError> {
  return Effect.try({
    try: () => {
      const user = selectSteamUserSync(root);
      if (!user) {
        throw new SteamUserNotFoundError({
          message: `No Steam userdata account was found in ${root}`,
        });
      }
      return user;
    },
    catch: (cause) => {
      if (
        cause instanceof SteamUserNotFoundError ||
        cause instanceof SteamVdfParseError
      ) {
        return cause;
      }
      return new SteamVdfParseError({
        message: `Could not inspect Steam userdata in ${root}`,
        path: root,
        cause,
      });
    },
  });
}

export function locateSteamLocations(
  candidates = getSteamRootCandidates()
): Effect.Effect<SteamLocation[], SteamRepositoryError> {
  return Effect.gen(function* () {
    const locations: Array<
      SteamLocation & { rootIndex: number; userIndex: number }
    > = [];
    let parseFailure: SteamVdfParseError | undefined;
    for (const [rootIndex, root] of candidates.entries()) {
      const users = yield* Effect.try({
        try: () => listSteamUsersSync(root),
        catch: (cause) =>
          cause instanceof SteamVdfParseError
            ? cause
            : new SteamVdfParseError({
                message: `Could not inspect Steam userdata in ${root}`,
                path: root,
                cause,
              }),
      }).pipe(
        Effect.catchAll((cause) => {
          parseFailure ??= cause;
          return Effect.succeed([] as SteamUser[]);
        })
      );
      locations.push(
        ...users.map((user, userIndex) => ({
          root,
          user,
          loginUsersPath: path.join(root, 'config/loginusers.vdf'),
          rootIndex,
          userIndex,
        }))
      );
    }
    if (locations.length === 0) {
      if (parseFailure) return yield* Effect.fail(parseFailure);
      return yield* Effect.fail(
        new SteamNotFoundError({
          message: 'No Steam installation with a userdata account was found',
        })
      );
    }
    return locations
      .sort(
        (left, right) =>
          Number(right.user.mostRecent) - Number(left.user.mostRecent) ||
          right.user.timestamp - left.user.timestamp ||
          left.rootIndex - right.rootIndex ||
          left.userIndex - right.userIndex
      )
      .map(
        ({ rootIndex: _rootIndex, userIndex: _userIndex, ...location }) =>
          location
      );
  });
}

export function locateSteam(
  candidates = getSteamRootCandidates()
): Effect.Effect<SteamLocation, SteamRepositoryError> {
  return locateSteamLocations(candidates).pipe(
    Effect.map((locations) => locations[0])
  );
}

export function writeFileAtomic(
  filePath: string,
  contents: Buffer | string
): Effect.Effect<void, SteamVdfWriteError> {
  return Effect.try({
    try: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.ogi-${process.pid}-${Date.now()}.tmp`;
      try {
        const descriptor = fs.openSync(temporary, 'w');
        try {
          fs.writeFileSync(descriptor, contents);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, filePath);
      } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      }
    },
    catch: (cause) =>
      new SteamVdfWriteError({
        message: `Could not atomically write ${filePath}`,
        path: filePath,
        cause,
      }),
  });
}

const shortcutsLock = Effect.unsafeMakeSemaphore(1);

export class SteamRepository extends Context.Tag('SteamRepository')<
  SteamRepository,
  {
    readonly locate: Effect.Effect<SteamLocation, SteamRepositoryError>;
    readonly locateAll: Effect.Effect<SteamLocation[], SteamRepositoryError>;
    readonly readShortcuts: (
      location: SteamLocation
    ) => Effect.Effect<
      { root: BinaryVdfObject; shortcutsPath: string },
      SteamVdfParseError | SteamVdfWriteError
    >;
    readonly writeShortcuts: (
      shortcutsPath: string,
      root: BinaryVdfObject
    ) => Effect.Effect<void, SteamVdfWriteError>;
    readonly modifyShortcuts: <A, E, R>(
      location: SteamLocation,
      mutation: (
        transaction: SteamShortcutsTransaction
      ) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SteamVdfParseError | SteamVdfWriteError, R>;
  }
>() {}

export const SteamRepositoryLive = (
  candidates?: string[]
): Layer.Layer<SteamRepository> => {
  const read = (
    location: SteamLocation
  ): Effect.Effect<
    {
      root: BinaryVdfObject;
      shortcutsPath: string;
      original: Buffer;
      existed: boolean;
    },
    SteamVdfParseError
  > =>
    Effect.try({
      try: () => {
        const existed = fs.existsSync(location.user.shortcutsPath);
        const original = existed
          ? fs.readFileSync(location.user.shortcutsPath)
          : Buffer.alloc(0);
        return {
          root: readShortcuts(original).root,
          shortcutsPath: location.user.shortcutsPath,
          original,
          existed,
        };
      },
      catch: (cause) =>
        cause instanceof SteamVdfParseError
          ? cause
          : new SteamVdfParseError({
              message: `Could not read ${location.user.shortcutsPath}`,
              path: location.user.shortcutsPath,
              cause,
            }),
    });
  const write = (shortcutsPath: string, root: BinaryVdfObject) =>
    writeFileAtomic(shortcutsPath, serializeBinaryVdf(root));

  return Layer.succeed(SteamRepository, {
    locate: Effect.suspend(() =>
      locateSteam(candidates ?? getSteamRootCandidates())
    ),
    locateAll: Effect.suspend(() =>
      locateSteamLocations(candidates ?? getSteamRootCandidates())
    ),
    readShortcuts: (location) =>
      read(location).pipe(
        Effect.map(({ root, shortcutsPath }) => ({ root, shortcutsPath }))
      ),
    writeShortcuts: write,
    modifyShortcuts: (location, mutation) =>
      shortcutsLock.withPermits(1)(
        Effect.gen(function* () {
          const { root, shortcutsPath, original, existed } =
            yield* read(location);
          let committed = false;
          const rollback = (
            existed
              ? writeFileAtomic(shortcutsPath, original)
              : Effect.try({
                  try: () => {
                    if (fs.existsSync(shortcutsPath)) fs.rmSync(shortcutsPath);
                  },
                  catch: (cause) =>
                    new SteamVdfWriteError({
                      message: `Could not restore missing ${shortcutsPath}`,
                      path: shortcutsPath,
                      cause,
                    }),
                })
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed = false;
              })
            )
          );
          return yield* mutation({
            root,
            shortcutsPath,
            commit: (updated = root) =>
              write(shortcutsPath, updated).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    committed = true;
                  })
                )
              ),
            rollback,
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && committed
                ? rollback.pipe(Effect.orDie)
                : Effect.void
            )
          );
        })
      ),
  });
};
