const { isAbsolute, relative, resolve } = require('node:path');

const descriptorKeys = [
  'version',
  'scenario',
  'runId',
  'mode',
  'sandboxDirectory',
  'applicationStateDirectory',
  'userDataDirectory',
  'artifactDirectory',
  'eventLogPath',
];
const accessibilityDescriptorKeys = [
  'version',
  'scenario',
  'state',
  'sandboxDirectory',
];

function isWithin(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

function validateDescriptorShape(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Run Descriptor must be an object');
  }
  const unknown = Object.keys(value).filter(
    (key) => !expectedKeys.includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`Run Descriptor has unknown fields: ${unknown.join(', ')}`);
  }
  const missing = expectedKeys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`Run Descriptor is missing fields: ${missing.join(', ')}`);
  }
}

function validateApplicationRunDescriptor(value) {
  validateDescriptorShape(value, descriptorKeys);
  if (
    value.version !== 1 ||
    value.scenario !== 'application-visible-navigation' ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    !['success', 'assertion-failure', 'flaky-once', 'helper-leak'].includes(
      value.mode
    )
  ) {
    throw new Error(
      'Run Descriptor version, scenario, runId, or mode is invalid'
    );
  }
  for (const key of descriptorKeys.slice(4)) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) {
      throw new Error(`Run Descriptor ${key} must be an absolute path`);
    }
  }
  for (const key of descriptorKeys.slice(5)) {
    if (!isWithin(value.sandboxDirectory, value[key])) {
      throw new Error(`Run Descriptor ${key} escapes the Scenario Sandbox`);
    }
  }
  return value;
}

function validateAccessibilityRunDescriptor(value) {
  validateDescriptorShape(value, accessibilityDescriptorKeys);
  if (
    value.version !== 1 ||
    value.scenario !== 'application-accessibility' ||
    !['welcome', 'oobe-resume', 'main'].includes(value.state)
  ) {
    throw new Error('Accessibility Run Descriptor fields are invalid');
  }
  if (
    typeof value.sandboxDirectory !== 'string' ||
    !isAbsolute(value.sandboxDirectory)
  ) {
    throw new Error('Run Descriptor sandboxDirectory must be an absolute path');
  }
  return value;
}

module.exports = {
  validateAccessibilityRunDescriptor,
  validateApplicationRunDescriptor,
};
