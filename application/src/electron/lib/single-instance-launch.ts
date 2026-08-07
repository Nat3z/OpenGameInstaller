import { quote as shellQuote } from 'shell-quote';

export type LaunchForwardPayload = {
  gameId: number;
  noLaunch: boolean;
  runPre: boolean;
  runPost: boolean;
  wrapperCommand?: string | null;
  originalArgv?: string[];
  launchEnv?: Record<string, string>;
};

export type SingleInstanceData = {
  launchEnv: Record<string, string>;
};

function collectLaunchEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function getForwardedLaunchEnvironment(
  additionalData: unknown,
  fallbackEnvironment: NodeJS.ProcessEnv
): Record<string, string> {
  if (
    typeof additionalData !== 'object' ||
    additionalData === null ||
    !('launchEnv' in additionalData) ||
    typeof additionalData.launchEnv !== 'object' ||
    additionalData.launchEnv === null
  ) {
    return collectLaunchEnvironment(fallbackEnvironment);
  }

  const entries = Object.entries(additionalData.launchEnv);
  if (!entries.every((entry) => typeof entry[1] === 'string')) {
    return collectLaunchEnvironment(fallbackEnvironment);
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

export function createSingleInstanceData(
  environment: NodeJS.ProcessEnv = process.env
): SingleInstanceData {
  return { launchEnv: collectLaunchEnvironment(environment) };
}

/** Parse the game ID supplied by an OGI-managed Steam shortcut. */
export function parseGameIdArg(
  argv: readonly string[] = process.argv
): number | null {
  const gameIdArg = argv.find((arg) => arg.startsWith('--game-id='));
  if (gameIdArg) {
    const gameId = parseInt(gameIdArg.split('=')[1], 10);
    if (!Number.isNaN(gameId)) {
      return gameId;
    }
  }
  return null;
}

/** Parse the pre/post hook flags used by Steam shortcut launches. */
export function parseLaunchHookArgs(argv: readonly string[] = process.argv): {
  noLaunch: boolean;
  runPre: boolean;
  runPost: boolean;
} {
  return {
    noLaunch: argv.includes('--no-launch'),
    runPre: argv.includes('--pre'),
    runPost: argv.includes('--post'),
  };
}

/** Preserve the Steam wrapper command following the `--` separator. */
export function parseWrapperAfterSeparator(
  argv: readonly string[] = process.argv
): string | null {
  const separatorIndex = argv.indexOf('--');
  if (separatorIndex === -1 || separatorIndex >= argv.length - 1) {
    return null;
  }

  const args = argv.slice(separatorIndex + 1);
  return args.map((arg) => shellQuote([arg])).join(' ');
}

export function parseLaunchRequestFromArgv(
  argv: readonly string[],
  additionalData?: unknown,
  fallbackEnvironment: NodeJS.ProcessEnv = process.env
): LaunchForwardPayload | null {
  const gameId = parseGameIdArg(argv);
  if (gameId === null) {
    return null;
  }

  const hookArgs = parseLaunchHookArgs(argv);
  return {
    gameId,
    noLaunch: hookArgs.noLaunch,
    runPre: hookArgs.runPre,
    runPost: hookArgs.runPost,
    wrapperCommand: parseWrapperAfterSeparator(argv),
    originalArgv: [...argv].slice(1),
    launchEnv: getForwardedLaunchEnvironment(
      additionalData,
      fallbackEnvironment
    ),
  };
}
