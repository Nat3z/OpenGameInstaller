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
  if (
    value.version !== 1 ||
    value.killOnClose !== true ||
    !validPid(value.rootPid) ||
    !Array.isArray(value.survivingPids) ||
    !value.survivingPids.every(validPid) ||
    new Set(value.survivingPids).size !== value.survivingPids.length ||
    typeof value.timedOut !== 'boolean'
  ) {
    throw new Error('Windows Job Object result evidence is invalid');
  }
  return {
    version: 1,
    rootPid: value.rootPid,
    survivingPids: [...value.survivingPids],
    timedOut: value.timedOut,
    killOnClose: true,
  };
}
