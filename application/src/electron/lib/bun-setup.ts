export type BunSetupAction =
  | { readonly type: 'ready' }
  | {
      readonly type: 'upgrade';
      readonly executable: string;
      readonly args: readonly string[];
    }
  | {
      readonly type: 'install';
      readonly commands: readonly string[];
      readonly executable?: string;
    }
  | { readonly type: 'unsupported' };

export type BunSetupEnvironment = {
  readonly installed: boolean;
  readonly bunPath?: string;
  readonly bunProvenance?: 'homebrew' | 'direct';
  readonly brewPath?: string;
  readonly bunInstallPath?: string;
  readonly isNixOS: boolean;
  readonly platform: NodeJS.Platform;
  readonly username: string;
};

export function getBunSetupAction({
  installed,
  bunPath,
  bunProvenance,
  brewPath,
  bunInstallPath,
  isNixOS,
  platform,
  username,
}: BunSetupEnvironment): BunSetupAction {
  if (installed) {
    if (isNixOS || !bunPath) return { type: 'ready' };
    if (bunProvenance === 'homebrew' && brewPath) {
      return {
        type: 'upgrade',
        executable: brewPath,
        args: ['upgrade', 'bun'],
      };
    }
    return { type: 'upgrade', executable: bunPath, args: ['upgrade'] };
  }

  if (platform === 'win32') {
    return {
      type: 'install',
      commands: ['powershell -c "irm bun.sh/install.ps1 | iex"'],
    };
  }

  if (platform === 'linux' && !isNixOS) {
    return {
      type: 'install',
      commands: [
        'curl -fsSL https://bun.com/install | bash',
        `echo "export PATH=$PATH:/home/${username}/.bun/bin" >> ~/.bashrc`,
      ],
    };
  }

  if (platform === 'darwin') {
    return {
      type: 'install',
      commands: ['curl -fsSL https://bun.com/install | bash'],
      executable: bunInstallPath,
    };
  }

  return { type: 'unsupported' };
}
