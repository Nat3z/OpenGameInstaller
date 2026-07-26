function parseJsonObject(contents, description) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${description} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} is invalid`);
  }
  return value;
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseWindowsJobLaunchEvidence(contents) {
  const value = parseJsonObject(contents, 'Windows Job Object launch evidence');
  if (
    value.version !== 1 ||
    value.killOnClose !== true ||
    !validPid(value.rootPid)
  ) {
    throw new Error('Windows Job Object launch evidence is invalid');
  }
  return {
    version: 1,
    rootPid: value.rootPid,
    killOnClose: true,
  };
}

export function parseWindowsJobResultEvidence(contents) {
  const value = parseJsonObject(contents, 'Windows Job Object result evidence');
  const commonValid =
    value.killOnClose === true &&
    validPid(value.rootPid) &&
    Array.isArray(value.activePidsBeforeClose) &&
    value.activePidsBeforeClose.every(validPid) &&
    new Set(value.activePidsBeforeClose).size ===
      value.activePidsBeforeClose.length &&
    Array.isArray(value.survivingPids) &&
    value.survivingPids.every(validPid) &&
    new Set(value.survivingPids).size === value.survivingPids.length &&
    typeof value.timedOut === 'boolean' &&
    value.survivingPids.every((pid) =>
      value.activePidsBeforeClose.includes(pid)
    );
  if (value.version === 2 && commonValid) {
    return {
      version: 2,
      rootPid: value.rootPid,
      activePidsBeforeClose: [...value.activePidsBeforeClose],
      survivingPids: [...value.survivingPids],
      timedOut: value.timedOut,
      killOnClose: true,
      verifiedAfterClose: false,
    };
  }
  if (
    value.version !== 3 ||
    !commonValid ||
    !Array.isArray(value.terminatedPids) ||
    !value.terminatedPids.every(validPid) ||
    new Set(value.terminatedPids).size !== value.terminatedPids.length ||
    !value.terminatedPids.every((pid) =>
      value.activePidsBeforeClose.includes(pid)
    ) ||
    value.terminatedPids.some((pid) => value.survivingPids.includes(pid)) ||
    value.terminatedPids.length + value.survivingPids.length !==
      value.activePidsBeforeClose.length ||
    !Array.isArray(value.errors) ||
    !value.errors.every((error) => typeof error === 'string')
  ) {
    throw new Error('Windows Job Object result evidence is invalid');
  }
  return {
    version: 3,
    rootPid: value.rootPid,
    activePidsBeforeClose: [...value.activePidsBeforeClose],
    terminatedPids: [...value.terminatedPids],
    survivingPids: [...value.survivingPids],
    timedOut: value.timedOut,
    errors: [...value.errors],
    killOnClose: true,
    verifiedAfterClose: true,
  };
}
