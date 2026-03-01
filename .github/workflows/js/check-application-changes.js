#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

const eventName = process.env.GITHUB_EVENT_NAME;
const eventBefore = process.env.GITHUB_EVENT_BEFORE;
const githubSha = process.env.GITHUB_SHA;
const githubOutput = process.env.GITHUB_OUTPUT;

function checkApplicationChanges() {
  // For tags or workflow_dispatch, assume changes exist
  if (eventName !== 'push' || !eventBefore) {
    setOutput('has_application_changes', 'true');
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

    // Check if any file starts with application/
    const hasChanges = changedFiles.some((file) =>
      file.startsWith('application/')
    );

    const hasWorkflowChanges = changedFiles.some((file) =>
      file.startsWith('.github/workflows/')
    );

    if (hasChanges || hasWorkflowChanges) {
      setOutput('has_application_changes', 'true');
      console.log('Found changes in application directory');
    } else {
      setOutput('has_application_changes', 'false');
      console.log('No changes in application directory');
    }
  } catch (error) {
    // If git diff fails, assume changes exist to be safe
    setOutput('has_application_changes', 'true');
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

checkApplicationChanges();
