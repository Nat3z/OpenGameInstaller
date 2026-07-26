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
  'applicationLauncherPath',
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
  'gameAutomationPort',
  'healthTimeoutMs',
  'recoveryFailure',
  'incrementalUpdate',
  'gameDownloadRecovery',
  'fixtureGameLifecycle',
  'offlineProductBehavior',
  'deterministicTorrentInstallation',
  'torrentUrl',
  'torrentTrackerUrl',
  'torrentPeerPort',
];

const pathKeys = [
  'sandboxDirectory',
  'updaterUserDataDirectory',
  'applicationUserDataDirectory',
  'applicationStateDirectory',
  'packagedUpdaterDirectory',
  'installationDirectory',
  'applicationLauncherPath',
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
  const expectedLauncher = resolve(
    value.installationDirectory,
    value.platform === 'win32'
      ? 'OpenGameInstaller.exe'
      : 'OpenGameInstaller.AppImage'
  );
  if (resolve(value.applicationLauncherPath) !== expectedLauncher) {
    throw new Error(
      'Run Descriptor applicationLauncherPath does not match the platform launcher'
    );
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
    !Number.isInteger(value.gameAutomationPort) ||
    value.gameAutomationPort < 1 ||
    value.gameAutomationPort > 65535
  ) {
    throw new Error('Run Descriptor gameAutomationPort is invalid');
  }
  if (
    !Number.isInteger(value.healthTimeoutMs) ||
    value.healthTimeoutMs < 1000 ||
    value.healthTimeoutMs > 120000
  ) {
    throw new Error('Run Descriptor healthTimeoutMs is invalid');
  }
  if (
    !['none', 'valid', 'corrupt', 'interrupted', 'fallback-failure'].includes(
      value.incrementalUpdate
    )
  ) {
    throw new Error('Run Descriptor incrementalUpdate is invalid');
  }
  if (typeof value.gameDownloadRecovery !== 'boolean') {
    throw new Error('Run Descriptor gameDownloadRecovery is invalid');
  }
  if (typeof value.fixtureGameLifecycle !== 'boolean') {
    throw new Error('Run Descriptor fixtureGameLifecycle is invalid');
  }
  if (typeof value.offlineProductBehavior !== 'boolean') {
    throw new Error('Run Descriptor offlineProductBehavior is invalid');
  }
  if (typeof value.deterministicTorrentInstallation !== 'boolean') {
    throw new Error(
      'Run Descriptor deterministicTorrentInstallation is invalid'
    );
  }
  if (value.deterministicTorrentInstallation) {
    const torrentUrl = validateLoopbackUrl(value.torrentUrl, 'torrentUrl');
    const trackerUrl = validateLoopbackUrl(
      value.torrentTrackerUrl,
      'torrentTrackerUrl'
    );
    if (torrentUrl.origin !== fixtureBaseUrl.origin) {
      throw new Error('Run Descriptor torrentUrl must use the Fixture Service');
    }
    if (trackerUrl.pathname !== '/announce') {
      throw new Error(
        'Run Descriptor torrentTrackerUrl must use the local tracker announce path'
      );
    }
    if (
      !Number.isInteger(value.torrentPeerPort) ||
      value.torrentPeerPort < 1 ||
      value.torrentPeerPort > 65535
    ) {
      throw new Error('Run Descriptor torrentPeerPort is invalid');
    }
  } else if (
    value.torrentUrl !== null ||
    value.torrentTrackerUrl !== null ||
    value.torrentPeerPort !== null
  ) {
    throw new Error(
      'Run Descriptor torrent fixture fields require deterministicTorrentInstallation'
    );
  }
  if (
    ![
      'none',
      'download',
      'incomplete-content',
      'unsafe-archive-path',
      'missing-required-file',
      'replacement',
      'crash',
      'pre-identity',
      'immediate-root-exit',
      'fork-during-scan',
      'timeout',
      'invalid-health',
    ].includes(value.recoveryFailure)
  ) {
    throw new Error('Run Descriptor recoveryFailure is invalid');
  }
  return value;
}

module.exports = { validatePackagedHandoffRunDescriptor };
