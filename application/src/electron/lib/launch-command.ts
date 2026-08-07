export type LaunchArgumentToken = {
  value: string;
  quoted: boolean;
};

export type ResolvedLaunchCommand = {
  command: string;
  args: string[];
  tokens: LaunchArgumentToken[];
};

const literalToken = (value: string): LaunchArgumentToken => ({
  value,
  quoted: true,
});

export function parseLaunchArgumentTokens(
  launchArguments?: string
): LaunchArgumentToken[] {
  const launchArgs = launchArguments ?? '';
  return (
    launchArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((rawToken) => {
      const trimmed = rawToken.trim();
      const quoted =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"));

      return {
        value: quoted ? trimmed.slice(1, -1) : trimmed,
        quoted,
      };
    }) ?? []
  );
}

export function resolveLaunchCommandTokens(
  executable: string,
  executableArgs: readonly string[],
  tokens: readonly (LaunchArgumentToken | string)[]
): ResolvedLaunchCommand {
  const normalizedTokens = tokens.map((token) =>
    typeof token === 'string' ? { value: token, quoted: false } : token
  );
  const commandIndex = normalizedTokens.findIndex(
    (token) => token.value === '%command%'
  );
  const executableTokens = [
    literalToken(executable),
    ...executableArgs.map(literalToken),
  ];
  const resolvedTokens =
    commandIndex === -1
      ? [...executableTokens, ...normalizedTokens]
      : normalizedTokens.flatMap((token) =>
          token.value === '%command%' ? executableTokens : token
        );
  const [commandToken = literalToken(executable), ...argTokens] =
    resolvedTokens;

  return {
    command: commandToken.value,
    args: argTokens.map((token) => token.value),
    tokens: [commandToken, ...argTokens],
  };
}
