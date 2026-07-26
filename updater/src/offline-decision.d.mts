export type UpdaterOnlineState = {
  requestedOnline: boolean | null;
  networkOnline: boolean;
  effectiveOnline: boolean;
  reason: 'online' | 'cli-offline' | 'network-offline';
};

export function getRequestedOnlineState(argv?: string[]): boolean | null;
export function resolveEffectiveOnlineState(
  requestedOnline: boolean | null,
  networkOnline: boolean
): UpdaterOnlineState;
export function decideUpdaterStartup(
  argv: string[],
  networkOnline: boolean
): {
  onlineState: UpdaterOnlineState;
  action: 'check-for-updates' | 'skip-update-and-launch-offline';
};
