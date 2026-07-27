import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type ElectronServiceOptions = {
  appBinaryPath: string;
  appArgs: string[];
};

export function resolveElectronExecutable(
  loadElectron: () => unknown = () => require('electron')
): string {
  const executable = loadElectron();
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error(
      'The electron package did not resolve to an executable path'
    );
  }
  if (
    /[\\/]node_modules[\\/]\.bin[\\/]/i.test(executable) ||
    /\.(?:cmd|bat)$/i.test(executable)
  ) {
    throw new Error(
      `Electron resolved to a command shim instead of its executable: ${executable}`
    );
  }
  return executable;
}

export function normalizeElectronArgumentPath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function createElectronServiceOptions(
  appEntryPoint: string,
  appArgs: string[],
  electronExecutable = resolveElectronExecutable()
): ElectronServiceOptions {
  return {
    appBinaryPath: electronExecutable,
    appArgs: [
      `--app=${normalizeElectronArgumentPath(appEntryPoint)}`,
      ...appArgs,
    ],
  };
}
