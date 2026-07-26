export function getRequestedOnlineState(argv = process.argv) {
  const onlineArg = argv.find((argument) => argument.startsWith('--online='));
  if (!onlineArg) return null;
  const value = onlineArg.slice('--online='.length).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function resolveEffectiveOnlineState(requestedOnline, networkOnline) {
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

export function decideUpdaterStartup(argv, networkOnline) {
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
