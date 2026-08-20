export type BunSetupAction =
  | { readonly type: 'ready' }
  | { readonly type: 'upgrade' }
  | { readonly type: 'install'; readonly commands: readonly string[] }
  | { readonly type: 'unsupported' };

export type BunSetupEnvironment = {
  readonly installed: boolean;
  readonly isNixOS: boolean;
  readonly platform: NodeJS.Platform;
  readonly username: string;
};

export function getBunSetupAction({
  installed,
  isNixOS,
  platform,
  username,
}: BunSetupEnvironment): BunSetupAction {
  if (installed) {
    return isNixOS ? { type: 'ready' } : { type: 'upgrade' };
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

  return { type: 'unsupported' };
}
