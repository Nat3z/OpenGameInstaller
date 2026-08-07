import type { SpawnOptions } from 'node:child_process';
import type { LaunchArgumentToken } from '@/electron/lib/launch-command.js';

const SHELL_OPERATOR_PATTERN = /^(?:&&|\|\||[|;&<>]|>>|<<)$/;
const INLINE_REDIRECTION_PATTERN = /^(?:\d+)?(?:>>?|<<?|<>|>&|<&).+$/;
const UNIX_SHELL_EXPANSION_PATTERN =
  /(?:^|[^\\])(?:\$(?:[A-Za-z_][A-Za-z0-9_]*|\(|\{)|`|[*?~])/;

export type SpawnInvocation = {
  command: string;
  args?: string[];
  shell: SpawnOptions['shell'];
};

export type SpawnContext = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
};

const getSpawnContext = (): SpawnContext => ({
  platform: process.platform,
  env: process.env,
});

function quoteUnixShellToken(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsShellToken(token: string): string {
  return `"${token.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function hasShellSyntax(token: LaunchArgumentToken): boolean {
  if (token.quoted) return false;
  return (
    SHELL_OPERATOR_PATTERN.test(token.value) ||
    INLINE_REDIRECTION_PATTERN.test(token.value) ||
    UNIX_SHELL_EXPANSION_PATTERN.test(token.value)
  );
}

function normalizeTokens(
  command: string,
  args: readonly string[],
  tokens?: readonly LaunchArgumentToken[]
): LaunchArgumentToken[] {
  if (tokens?.length === args.length + 1) {
    return [...tokens];
  }
  return [command, ...args].map((value) => ({ value, quoted: false }));
}

export function inferSpawnShell(
  command: string,
  args: readonly string[],
  tokens?: readonly LaunchArgumentToken[],
  context: SpawnContext = getSpawnContext()
): SpawnOptions['shell'] {
  const resolvedTokens = normalizeTokens(command, args, tokens);
  const usesShellSyntax = resolvedTokens.some(hasShellSyntax);

  if (context.platform === 'win32') {
    if (/\.(?:bat|cmd)$/i.test(command) || usesShellSyntax) {
      return context.env.ComSpec ?? context.env.COMSPEC ?? 'cmd.exe';
    }
    return false;
  }

  const needsUnixShell =
    /\.(?:bash|command|sh|zsh)$/i.test(command) || usesShellSyntax;

  return needsUnixShell ? (context.env.SHELL ?? '/bin/bash') : false;
}

export function resolveSpawnInvocation(
  command: string,
  args: readonly string[],
  tokens?: readonly LaunchArgumentToken[],
  context: SpawnContext = getSpawnContext()
): SpawnInvocation {
  if (context.platform === 'win32' && /\.ps1$/i.test(command)) {
    return {
      command: context.env.POWERSHELL_PATH ?? 'powershell.exe',
      args: ['-File', command, ...args],
      shell: false,
    };
  }

  const resolvedTokens = normalizeTokens(command, args, tokens);
  const shell = inferSpawnShell(command, args, resolvedTokens, context);
  if (!shell) {
    return { command, args: [...args], shell: false };
  }

  const quoteToken =
    context.platform === 'win32' ? quoteWindowsShellToken : quoteUnixShellToken;

  return {
    command: resolvedTokens
      .map((token) =>
        hasShellSyntax(token) ? token.value : quoteToken(token.value)
      )
      .join(' '),
    shell,
  };
}
