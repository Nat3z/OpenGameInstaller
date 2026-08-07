import type { SpawnOptions } from 'node:child_process';

const SHELL_OPERATOR_PATTERN = /^(?:&&|\|\||[|;&<>]|>>?|<<)(?:.*)?$/;
const UNIX_SHELL_EXPANSION_PATTERN = /(?:^|[^\\])(?:\$\(|\$\{|`|[*?~])/;

export function inferSpawnShell(
  command: string,
  args: readonly string[]
): SpawnOptions['shell'] {
  const usesShellSyntax = [command, ...args].some((token) =>
    SHELL_OPERATOR_PATTERN.test(token)
  );

  if (process.platform === 'win32') {
    if (/\.ps1$/i.test(command)) {
      return process.env.POWERSHELL_PATH ?? 'powershell.exe';
    }
    if (/\.(?:bat|cmd)$/i.test(command) || usesShellSyntax) {
      return process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    }
    return false;
  }

  const needsUnixShell =
    /\.(?:bash|command|sh|zsh)$/i.test(command) ||
    usesShellSyntax ||
    [command, ...args].some((token) =>
      UNIX_SHELL_EXPANSION_PATTERN.test(token)
    );

  return needsUnixShell ? (process.env.SHELL ?? '/bin/bash') : false;
}
