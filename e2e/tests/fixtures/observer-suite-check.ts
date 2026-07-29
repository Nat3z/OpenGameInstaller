import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRunEventWriter } from '../../src/run-events';

const runRoot = process.env.OGI_E2E_RUN_ROOT;
if (!runRoot) throw new Error('OGI_E2E_RUN_ROOT is required');
const checkId = process.argv[2] ?? 'fixture-check';
const behavior = process.argv[3] ?? 'pass';
const runId = randomUUID();
mkdirSync(runRoot, { recursive: true });
const sandboxDirectory = mkdtempSync(join(runRoot, `${checkId}-`));
const artifactDirectory = join(sandboxDirectory, 'artifacts');
mkdirSync(artifactDirectory);
const eventLogPath = join(sandboxDirectory, 'events.jsonl');
writeFileSync(eventLogPath, '');
const writeEvent = makeRunEventWriter(eventLogPath, runId);
const scenarioId = `${checkId}-scenario`;
const stepId = 'fixture-step';
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({
  type: 'scenario.started',
  payload: { scenarioId, kind: 'Application Scenario' },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId, attempt: 1 },
});
writeEvent({
  type: 'step.started',
  payload: { stepId, name: `Execute ${checkId}` },
});

if (behavior === 'wait') {
  setInterval(() => {}, 1_000);
} else {
  const artifactPath = join(artifactDirectory, `${checkId}.json`);
  writeFileSync(artifactPath, JSON.stringify({ checkId }));
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'run-descriptor',
      path: `artifacts/${checkId}.json`,
      stepId,
    },
  });
  const outcome = behavior === 'fail' ? 'Failed' : 'Passed';
  writeEvent({
    type: 'step.completed',
    payload: {
      stepId,
      outcome,
      ...(outcome === 'Failed' ? { error: `${checkId} failed` } : {}),
    },
  });
  writeEvent({
    type: 'attempt.completed',
    payload: { attempt: 1, outcome },
  });
  writeEvent({
    type: 'scenario.completed',
    payload: { scenarioId, outcome },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
  process.exitCode = behavior === 'fail' ? 1 : 0;
}
