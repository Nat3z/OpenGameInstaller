export type OnlineStateReason = 'network-offline' | 'cli-offline' | 'online';

export type EffectiveOnlineState = {
  requestedOnline: boolean | null;
  networkOnline: boolean;
  effectiveOnline: boolean;
  reason: OnlineStateReason;
};

export function getRequestedOnlineState(
  argv: readonly string[] = process.argv
): boolean | null {
  const onlineArg = argv.find((argument) => argument.startsWith('--online='));
  if (!onlineArg) return null;
  const value = onlineArg.slice('--online='.length).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function resolveEffectiveOnlineState(
  requestedOnline: boolean | null,
  networkOnline: boolean
): EffectiveOnlineState {
  if (!networkOnline) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'network-offline',
    };
  }
  if (requestedOnline === false) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'cli-offline',
    };
  }
  return {
    requestedOnline,
    networkOnline,
    effectiveOnline: true,
    reason: 'online',
  };
}
