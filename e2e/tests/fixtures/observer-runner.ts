import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunEventWriter } from '../../src/run-events';

const announcementPath = process.env.OGI_OBSERVER_ANNOUNCEMENT;
if (!announcementPath) throw new Error('OGI_OBSERVER_ANNOUNCEMENT is required');
const behavior = process.argv[2] ?? 'complete';
const runId = randomUUID();
const sandboxDirectory = mkdtempSync(join(tmpdir(), 'ogi-observer-runner-'));
const artifactDirectory = join(sandboxDirectory, 'artifacts');
const eventLogPath = join(sandboxDirectory, 'events.jsonl');
mkdirSync(artifactDirectory);
writeFileSync(
  announcementPath,
  JSON.stringify({ runId, sandboxDirectory, eventLogPath })
);
const writeEvent = makeRunEventWriter(eventLogPath, runId);
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({
  type: 'scenario.started',
  payload: {
    scenarioId: 'application-visible-navigation',
    kind: 'Application Scenario',
  },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId: 'application-visible-navigation', attempt: 1 },
});
writeEvent({
  type: 'step.started',
  payload: { stepId: 'navigate-discovery', name: 'Navigate to Discovery' },
});

const complete = (outcome: 'Passed' | 'Cancelled' | 'Failed') => {
  if (outcome === 'Passed') {
    writeEvent({
      type: 'step.completed',
      payload: { stepId: 'navigate-discovery', outcome: 'Passed' },
    });
  }
  writeEvent({ type: 'attempt.completed', payload: { attempt: 1, outcome } });
  writeEvent({
    type: 'scenario.completed',
    payload: { scenarioId: 'application-visible-navigation', outcome },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
};

const cancel = () => {
  complete('Cancelled');
  process.exit(0);
};
process.once('SIGTERM', cancel);
const cancellationPath = process.env.OGI_OBSERVER_CANCELLATION;
if (cancellationPath) {
  setInterval(() => {
    if (existsSync(cancellationPath)) cancel();
  }, 20);
}

if (behavior === 'complete') {
  setTimeout(() => {
    complete('Passed');
    process.exit(0);
  }, 250);
} else if (behavior === 'fail') {
  setTimeout(() => {
    complete('Failed');
    process.exit(1);
  }, 100);
} else {
  setInterval(() => {}, 1_000);
}
