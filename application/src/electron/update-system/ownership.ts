import type { ScannedFile } from './files.js';
import type { OwnershipManifest, UpdateManifest } from './model.js';

export function captureOwnershipFiles(
  manifest: UpdateManifest,
  installed: readonly ScannedFile[],
  beforeFiles: readonly ScannedFile[],
  previous: OwnershipManifest | undefined
): OwnershipManifest['files'] {
  const installedByHash = new Map<string, ScannedFile[]>();
  for (const file of installed) {
    const candidates = installedByHash.get(file.sha256) ?? [];
    installedByHash.set(file.sha256, [...candidates, file]);
  }
  const previousBySource = new Map(
    previous?.files.flatMap((file) =>
      file.sourcePath ? ([[file.sourcePath, file]] as const) : []
    ) ?? []
  );
  const unchangedPreexisting = new Set(
    beforeFiles
      .filter((before) =>
        installed.some(
          (file) => file.path === before.path && file.sha256 === before.sha256
        )
      )
      .map((file) => file.path)
  );
  const files: OwnershipManifest['files'][number][] = [];
  for (const entry of manifest.entries) {
    const previousFile = previousBySource.get(entry.path);
    const sameOutput = previousFile
      ? installed.find(
          (file) =>
            file.path === previousFile.installedPath &&
            file.sha256 === entry.sha256
        )
      : undefined;
    const samePath = installed.find(
      (file) =>
        file.path === entry.path &&
        file.sha256 === entry.sha256 &&
        (!previous || !unchangedPreexisting.has(file.path))
    );
    const hashMatches = (installedByHash.get(entry.sha256) ?? []).filter(
      (file) => !unchangedPreexisting.has(file.path)
    );
    const match =
      sameOutput ??
      samePath ??
      (hashMatches.length === 1 ? hashMatches[0] : undefined);
    if (!match) continue;
    files.push({
      sourcePath: entry.path,
      installedPath: match.path,
      size: match.size,
      sha256: match.sha256,
    });
  }
  const capturedPaths = new Set(files.map((file) => file.installedPath));
  for (const generated of previous?.files ?? []) {
    if (generated.sourcePath || capturedPaths.has(generated.installedPath))
      continue;
    const output = installed.find(
      (file) => file.path === generated.installedPath
    );
    if (!output) continue;
    files.push({
      installedPath: output.path,
      size: output.size,
      sha256: output.sha256,
    });
    capturedPaths.add(output.path);
  }
  const beforePaths = new Set(beforeFiles.map((file) => file.path));
  for (const output of installed) {
    if (capturedPaths.has(output.path) || beforePaths.has(output.path))
      continue;
    files.push({
      installedPath: output.path,
      size: output.size,
      sha256: output.sha256,
    });
  }
  return files;
}
