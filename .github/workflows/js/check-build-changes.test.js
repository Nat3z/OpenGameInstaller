const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hasReleaseBuildChanges } = require('./check-build-changes.js');

test('builds for application changes', () => {
  assert.equal(
    hasReleaseBuildChanges(['application/src/electron/updater.ts']),
    true
  );
});

test('builds for updater changes', () => {
  assert.equal(hasReleaseBuildChanges(['updater/src/main.ts']), true);
});

test('builds for workflow changes', () => {
  assert.equal(
    hasReleaseBuildChanges(['.github/workflows/build-release.yml']),
    true
  );
});

test('skips unrelated changes', () => {
  assert.equal(hasReleaseBuildChanges(['README.md']), false);
});
