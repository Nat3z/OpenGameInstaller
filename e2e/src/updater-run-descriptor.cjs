const { isAbsolute, relative, resolve } = require('node:path');

const descriptorKeys = [
  'version',
  'scenario',
  'runId',
  'sandboxDirectory',
  'userDataDirectory',
  'installationDirectory',
  'artifactDirectory',
  'fixtureStateDirectory',
  'eventLogPath',
  'nativeDialogLogPath',
  'fixtureBaseUrl',
  'releaseApiUrl',
  'nativeDialogResponses',
];

const pathKeys = [
  'sandboxDirectory',
  'userDataDirectory',
  'installationDirectory',
  'artifactDirectory',
  'fixtureStateDirectory',
  'eventLogPath',
  'nativeDialogLogPath',
];

function isWithin(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

function validateLoopbackUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Run Descriptor ${name} must be a valid URL`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  ) {
    throw new Error(`Run Descriptor ${name} must use loopback HTTP`);
  }
  return parsed;
}

function validateUpdaterRunDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Run Descriptor must be an object');
  }
  const unknown = Object.keys(value).filter(
    (key) => !descriptorKeys.includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`Run Descriptor has unknown fields: ${unknown.join(', ')}`);
  }
  const missing = descriptorKeys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`Run Descriptor is missing fields: ${missing.join(', ')}`);
  }
  if (
    value.version !== 1 ||
    value.scenario !== 'updater-fixture-release' ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0
  ) {
    throw new Error('Run Descriptor version, scenario, or runId is invalid');
  }
  for (const key of pathKeys) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) {
      throw new Error(`Run Descriptor ${key} must be an absolute path`);
    }
  }
  for (const key of pathKeys.slice(1)) {
    if (!isWithin(value.sandboxDirectory, value[key])) {
      throw new Error(`Run Descriptor ${key} escapes the Scenario Sandbox`);
    }
  }

  const fixtureBaseUrl = validateLoopbackUrl(
    value.fixtureBaseUrl,
    'fixtureBaseUrl'
  );
  const releaseApiUrl = validateLoopbackUrl(
    value.releaseApiUrl,
    'releaseApiUrl'
  );
  if (releaseApiUrl.origin !== fixtureBaseUrl.origin) {
    throw new Error(
      'Run Descriptor releaseApiUrl must use the Fixture Service'
    );
  }
  if (releaseApiUrl.pathname !== '/repos/Nat3z/OpenGameInstaller/releases') {
    throw new Error('Run Descriptor releaseApiUrl path is invalid');
  }
  if (
    !Array.isArray(value.nativeDialogResponses) ||
    value.nativeDialogResponses.length !== 1
  ) {
    throw new Error('Run Descriptor nativeDialogResponses is invalid');
  }
  const response = value.nativeDialogResponses[0];
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(response).some(
      (key) => !['action', 'response'].includes(key)
    ) ||
    response.action !== 'choose-stable-channel' ||
    !Number.isInteger(response.response) ||
    response.response < 0
  ) {
    throw new Error('Run Descriptor nativeDialogResponses is invalid');
  }
  return value;
}

module.exports = { validateUpdaterRunDescriptor };
