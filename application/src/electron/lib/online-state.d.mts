export type EffectiveOnlineState = {
  requestedOnline: boolean | null;
  networkOnline: boolean;
  effectiveOnline: boolean;
  reason: 'online' | 'cli-offline' | 'network-offline';
};

export function getRequestedOnlineState(argv?: string[]): boolean | null;
export function resolveEffectiveOnlineState(
  requestedOnline: boolean | null,
  networkOnline: boolean
): EffectiveOnlineState;
