import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunEventWriter, readRunEvents } from '../../src/run-events';

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
const live = behavior === 'live';
if (behavior === 'assert-no-live-env') {
  if (Object.keys(process.env).some((key) => key.startsWith('OGI_LIVE_'))) {
    throw new Error('deterministic runner inherited a Live Service credential');
  }
}
if (live) {
  const credential = process.env.OGI_LIVE_SERVICE_CREDENTIAL;
  const providerIndex = process.argv.indexOf('--provider');
  if (
    !credential ||
    process.argv[providerIndex + 1] !== 'synthetic-local' ||
    !process.argv.includes('--confirm-live-service') ||
    process.env.OGI_LIVE_SERVICE_PROVIDER !== undefined ||
    process.env.OGI_LIVE_SERVICE_CONFIRMED !== undefined
  ) {
    throw new Error(
      'Live Service runner did not receive explicit authenticated handoff arguments'
    );
  }
  let percentToken = 0;
  const mixedPercent = encodeURIComponent(credential).replace(
    /%[0-9A-F]{2}/g,
    (value) => {
      percentToken += 1;
      return percentToken % 2 === 0 ? value.toLowerCase() : value.toUpperCase();
    }
  );
  for (const [label, variant] of [
    ['authorization Bearer', credential],
    ['base64url', Buffer.from(credential).toString('base64url')],
    ['hex', Buffer.from(credential).toString('hex')],
    [
      'form',
      new URLSearchParams({ token: credential })
        .toString()
        .slice('token='.length),
    ],
    ['mixed-percent', mixedPercent],
    ['double-percent', encodeURIComponent(mixedPercent)],
  ]) {
    const split = Math.floor(variant.length / 2);
    process.stdout.write(
      `synthetic provider ${label} ${variant.slice(0, split)}`
    );
    await Bun.sleep(10);
    process.stdout.write(`${variant.slice(split)}\n`);
  }
}
const scenarioId = live
  ? 'live-service-synthetic-local'
  : 'application-visible-navigation';
writeEvent({
  type: 'scenario.started',
  payload: {
    scenarioId,
    kind: live ? 'Live Service Scenario' : 'Application Scenario',
  },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId, attempt: 1 },
});
writeEvent({
  type: 'step.started',
  payload: { stepId: 'navigate-discovery', name: 'Navigate to Discovery' },
});
if (live) {
  writeEvent({
    type: 'external-integration.health',
    payload: {
      provider: 'synthetic-local',
      status: 'Healthy',
      deterministicCoverage: 'Not evaluated',
      responseStatus: 200,
    },
  });
}

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
    payload: { scenarioId, outcome },
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

if (
  behavior === 'complete' ||
  behavior === 'complete-delete' ||
  behavior === 'live' ||
  behavior === 'assert-no-live-env'
) {
  setTimeout(() => {
    complete('Passed');
    if (behavior === 'complete-delete') {
      writeFileSync(
        announcementPath,
        JSON.stringify({
          runId,
          sandboxDirectory,
          eventLogPath,
          events: readRunEvents(eventLogPath),
        })
      );
      rmSync(sandboxDirectory, { recursive: true, force: true });
    }
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
