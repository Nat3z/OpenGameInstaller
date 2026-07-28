import {
  type EffectiveOnlineState,
  getRequestedOnlineState,
  resolveEffectiveOnlineState,
} from '@ogi/online-state';

export { getRequestedOnlineState, resolveEffectiveOnlineState };

export type UpdaterOnlineState = EffectiveOnlineState;

export function decideUpdaterStartup(
  argv: readonly string[],
  networkOnline: boolean
): {
  onlineState: UpdaterOnlineState;
  action: 'check-for-updates' | 'skip-update-and-launch-offline';
} {
  const onlineState = resolveEffectiveOnlineState(
    getRequestedOnlineState(argv),
    networkOnline
  );
  return {
    onlineState,
    action: onlineState.effectiveOnline
      ? 'check-for-updates'
      : 'skip-update-and-launch-offline',
  };
}
