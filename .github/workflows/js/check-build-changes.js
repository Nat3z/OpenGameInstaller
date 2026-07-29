#!/usr/bin/env node

// Decide whether a push affects the desktop release artifacts.

const { execSync } = require('child_process');
const fs = require('fs');

const eventName = process.env.GITHUB_EVENT_NAME;
const eventBefore = process.env.GITHUB_EVENT_BEFORE;
const githubSha = process.env.GITHUB_SHA;
const githubOutput = process.env.GITHUB_OUTPUT;

function hasReleaseBuildChanges(changedFiles) {
  return changedFiles.some(
    (file) =>
      file.startsWith('application/') ||
      file.startsWith('updater/') ||
      file.startsWith('.github/workflows/')
  );
}

function checkReleaseBuildChanges() {
  // For tags or workflow_dispatch, assume changes exist
  if (eventName !== 'push' || !eventBefore) {
    setOutput('has_build_changes', 'true');
    console.log('Not a push event or no before commit, assuming changes exist');
    return;
  }

  try {
    // Get list of changed files
    const changedFiles = execSync(
      `git diff --name-only ${eventBefore} ${githubSha}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    if (hasReleaseBuildChanges(changedFiles)) {
      setOutput('has_build_changes', 'true');
      console.log('Found release build changes');
    } else {
      setOutput('has_build_changes', 'false');
      console.log('No release build changes');
    }
  } catch (error) {
    // If git diff fails, assume changes exist to be safe
    setOutput('has_build_changes', 'true');
    console.log(
      'Error checking changes, assuming changes exist:',
      error.message
    );
  }
}

function setOutput(name, value) {
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `${name}=${value}\n`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

if (require.main === module) {
  checkReleaseBuildChanges();
}

module.exports = { hasReleaseBuildChanges };
