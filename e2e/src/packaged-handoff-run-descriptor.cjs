const { isAbsolute, relative, resolve } = require('node:path');

const descriptorKeys = [
  'version',
  'scenario',
  'runId',
  'platform',
  'sandboxDirectory',
  'updaterUserDataDirectory',
  'applicationUserDataDirectory',
  'applicationStateDirectory',
  'packagedUpdaterDirectory',
  'installationDirectory',
  'backupDirectory',
  'stagingDirectory',
  'artifactDirectory',
  'fixtureStateDirectory',
  'eventLogPath',
  'handoffLogPath',
  'startupHealthPath',
  'fixtureBaseUrl',
  'releaseApiUrl',
  'artifactUrl',
  'automationPort',
  'clientSdkPort',
  'healthTimeoutMs',
];

const pathKeys = [
  'sandboxDirectory',
  'updaterUserDataDirectory',
  'applicationUserDataDirectory',
  'applicationStateDirectory',
  'packagedUpdaterDirectory',
  'installationDirectory',
  'backupDirectory',
  'stagingDirectory',
  'artifactDirectory',
  'fixtureStateDirectory',
  'eventLogPath',
  'handoffLogPath',
  'startupHealthPath',
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

function validatePackagedHandoffRunDescriptor(value) {
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
    value.scenario !== 'packaged-updater-application-handoff' ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    !['linux', 'win32'].includes(value.platform)
  ) {
    throw new Error(
      'Run Descriptor version, scenario, runId, or platform is invalid'
    );
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
  for (const key of ['releaseApiUrl', 'artifactUrl']) {
    const parsed = validateLoopbackUrl(value[key], key);
    if (parsed.origin !== fixtureBaseUrl.origin) {
      throw new Error(`Run Descriptor ${key} must use the Fixture Service`);
    }
  }
  if (
    !Number.isInteger(value.automationPort) ||
    value.automationPort < 1 ||
    value.automationPort > 65535
  ) {
    throw new Error('Run Descriptor automationPort is invalid');
  }
  if (
    !Number.isInteger(value.clientSdkPort) ||
    value.clientSdkPort < 1 ||
    value.clientSdkPort > 65535
  ) {
    throw new Error('Run Descriptor clientSdkPort is invalid');
  }
  if (
    !Number.isInteger(value.healthTimeoutMs) ||
    value.healthTimeoutMs < 1000 ||
    value.healthTimeoutMs > 120000
  ) {
    throw new Error('Run Descriptor healthTimeoutMs is invalid');
  }
  return value;
}

module.exports = { validatePackagedHandoffRunDescriptor };
