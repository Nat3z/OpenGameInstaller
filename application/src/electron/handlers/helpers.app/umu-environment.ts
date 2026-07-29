export type UmuRedistributableEnvironmentOptions = {
  baseEnvironment?: NodeJS.ProcessEnv;
  gameId: string;
  winePrefix: string;
  cwd: string;
  protonPath?: string;
};

export type UmuLaunchEnvironmentOptions =
  UmuRedistributableEnvironmentOptions & {
    launchEnvironment?: Record<string, string>;
  };

function getUmuEnvironment({
  baseEnvironment = process.env,
  gameId,
  winePrefix,
  cwd,
  protonPath,
  additionalEnvironment = {},
}: UmuRedistributableEnvironmentOptions & {
  additionalEnvironment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    ...additionalEnvironment,
    GAMEID: gameId,
    WINEPREFIX: winePrefix,
    UMU_LOG: 'debug',
    // Xalia is Proton-GE's accessibility helper. Its own VC++/.NET dependency
    // prompts can be mistaken for game prerequisites and block unattended work.
    PROTON_USE_XALIA: '0',
    PWD: cwd,
  };

  if (protonPath) {
    environment.PROTONPATH = protonPath;
  }

  return environment;
}

export function getUmuLaunchEnvironment({
  launchEnvironment,
  ...options
}: UmuLaunchEnvironmentOptions): NodeJS.ProcessEnv {
  return getUmuEnvironment({
    ...options,
    additionalEnvironment: launchEnvironment,
  });
}

export function getUmuRedistributableEnvironment(
  options: UmuRedistributableEnvironmentOptions
): NodeJS.ProcessEnv {
  return getUmuEnvironment(options);
}
