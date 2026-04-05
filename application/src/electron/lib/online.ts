import { net } from 'electron';

export type EffectiveOnlineState = {
  requestedOnline: boolean | null;
  networkOnline: boolean;
  effectiveOnline: boolean;
  reason: 'online' | 'cli-offline' | 'network-offline';
};

export function getRequestedOnlineState(argv: string[] = process.argv) {
  const onlineArg = argv.find((arg) => arg.startsWith('--online='));
  if (!onlineArg) {
    return null;
  }

  const value = onlineArg.slice('--online='.length).trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  return null;
}

export function getEffectiveOnlineState(
  argv: string[] = process.argv
): EffectiveOnlineState {
  const requestedOnline = getRequestedOnlineState(argv);
  const networkOnline = net.isOnline();

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
