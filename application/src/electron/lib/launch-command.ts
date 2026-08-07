export type ResolvedLaunchCommand = {
  command: string;
  args: string[];
};

export function resolveLaunchCommandTokens(
  executable: string,
  executableArgs: readonly string[],
  tokens: readonly string[]
): ResolvedLaunchCommand {
  const commandIndex = tokens.indexOf('%command%');
  if (commandIndex === -1) {
    return {
      command: executable,
      args: [...executableArgs, ...tokens],
    };
  }

  const resolvedTokens = tokens.flatMap((token) =>
    token === '%command%' ? [executable, ...executableArgs] : token
  );
  const [command = executable, ...args] = resolvedTokens;

  return {
    command,
    args,
  };
}
