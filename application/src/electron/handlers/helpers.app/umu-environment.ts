export type UmuRedistributableEnvironmentOptions = {
  baseEnvironment?: NodeJS.ProcessEnv;
  gameId: string;
  winePrefix: string;
  cwd: string;
  protonPath?: string;
};

export function getUmuRedistributableEnvironment({
  baseEnvironment = process.env,
  gameId,
  winePrefix,
  cwd,
  protonPath,
}: UmuRedistributableEnvironmentOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    GAMEID: gameId,
    WINEPREFIX: winePrefix,
    UMU_LOG: 'debug',
    // Xalia is Proton-GE's .NET accessibility helper. Letting it start while
    // Winetricks is replacing .NET can display a framework prompt and block an
    // otherwise unattended redistributable installation.
    PROTON_USE_XALIA: '0',
    PWD: cwd,
  };

  if (protonPath) {
    environment.PROTONPATH = protonPath;
  }

  return environment;
}
