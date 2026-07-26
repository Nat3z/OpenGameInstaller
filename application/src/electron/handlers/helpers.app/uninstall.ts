import type { LibraryInfo } from '@ogi-sdk/connect';
import * as fs from 'fs';
import { isAbsolute, parse, relative, resolve, sep } from 'path';

function isStrictDescendant(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent.length > 0 &&
    !pathFromParent.startsWith('..') &&
    !isAbsolute(pathFromParent)
  );
}

function assertNoLinkComponents(targetPath: string, label: string): void {
  const resolvedPath = resolve(targetPath);
  const root = parse(resolvedPath).root;
  const segments = relative(root, resolvedPath).split(sep).filter(Boolean);
  let currentPath = root;

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    if (!fs.existsSync(currentPath)) return;
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Refusing to delete through a symbolic-link ${label}`);
    }
  }
}

export function deleteOwnedInstallDirectory(
  libraryInfo: Pick<LibraryInfo, 'installDirectory' | 'installRoot'>,
  stateDirectory: string
): boolean {
  if (!libraryInfo.installDirectory || !libraryInfo.installRoot) {
    throw new Error(
      'This game has no verified install ownership. Remove it from Library without deleting files.'
    );
  }

  const installRoot = resolve(stateDirectory, libraryInfo.installRoot);
  const installDirectory = resolve(
    stateDirectory,
    libraryInfo.installDirectory
  );
  if (!isStrictDescendant(installRoot, installDirectory)) {
    throw new Error(
      'Refusing to delete files outside the directory that owned this install'
    );
  }

  assertNoLinkComponents(installRoot, 'install ownership root');
  assertNoLinkComponents(installDirectory, 'install path');
  if (!fs.existsSync(installDirectory)) return false;

  const realInstallRoot = fs.realpathSync(installRoot);
  const realInstallDirectory = fs.realpathSync(installDirectory);
  if (!isStrictDescendant(realInstallRoot, realInstallDirectory)) {
    throw new Error(
      'Refusing to delete through a path outside the directory that owned this install'
    );
  }

  fs.rmSync(installDirectory, { recursive: true, force: true });
  return true;
}
