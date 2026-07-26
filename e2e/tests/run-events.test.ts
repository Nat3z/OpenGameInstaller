import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretRedactor } from '../src/live-service-scenarios';
import {
  makeRunEventWriter,
  parseRunEvent,
  type RunEvent,
  readRecoveryHandoffEvents,
  readRunEvents,
  renderRunHtmlReport,
  replayRunEventLog,
} from '../src/run-events';

const event = (
  sequence: number,
  type: RunEvent['type'],
  payload: unknown
): unknown => ({
  version: 1,
  runId: 'run-1',
  sequence,
  timestamp: '2026-07-25T00:00:00.000Z',
  type,
  payload,
});

describe('Run Event Log', () => {
  test('validates versioned events and rejects malformed payloads', () => {
    expect(
      parseRunEvent(event(1, 'run.started', { platform: 'linux' })).type
    ).toBe('run.started');
    expect(() =>
      parseRunEvent(
        event(2, 'step.completed', { stepId: 'navigate-discovery' })
      )
    ).toThrow('step.completed');
    expect(() =>
      parseRunEvent(
        event(3, 'artifact.created', {
          artifactType: 'unknown-artifact',
          path: 'artifacts/unknown',
        })
      )
    ).toThrow('artifact.created');
    expect(
      parseRunEvent(
        event(4, 'recovery.performed', {
          phase: 'last-known-good-launched',
          version: 'v0.0.1-e2e',
          pid: 1234,
        })
      ).type
    ).toBe('recovery.performed');
    expect(() =>
      parseRunEvent(
        event(5, 'recovery.performed', { phase: 'candidate-deleted' })
      )
    ).toThrow('recovery.performed');
  });

  test('redacts registered secrets before appending events and reports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-redaction-'));
    const path = join(directory, 'events.jsonl');
    const secret = 'synthetic-event-secret';
    const writeEvent = makeRunEventWriter(
      path,
      'redacted-run',
      0,
      createSecretRedactor([secret])
    );
    writeEvent({ type: 'run.started', payload: { platform: 'linux' } });
    writeEvent({
      type: 'scenario.started',
      payload: {
        scenarioId: 'live-service-synthetic-local',
        kind: 'Live Service Scenario',
      },
    });
    writeEvent({
      type: 'step.started',
      payload: { stepId: 'health', name: `Bearer ${secret}` },
    });
    writeEvent({
      type: 'external-integration.health',
      payload: {
        provider: 'synthetic-local',
        status: 'Unhealthy',
        deterministicCoverage: 'Not evaluated',
        error: `request token=${secret}`,
      },
    });
    writeEvent({
      type: 'step.completed',
      payload: {
        stepId: 'health',
        outcome: 'Failed',
        error: `credential ${secret}`,
      },
    });
    const contents = readFileSync(path, 'utf8');
    expect(contents).not.toContain(secret);
    expect(contents).toContain('[REDACTED]');
    const report = renderRunHtmlReport(path, 'Failed');
    expect(report).not.toContain(secret);
    expect(report).toContain('External integration health');
    expect(report).toContain('does not replace deterministic coverage');
  });

  test('preserves recovery timestamps before step completion and shutdown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-recovery-'));
    const handoffPath = join(directory, 'handoff.jsonl');
    const eventPath = join(directory, 'events.jsonl');
    const recoveryTimestamps = [
      '2026-07-25T00:00:01.000Z',
      '2026-07-25T00:00:02.000Z',
      '2026-07-25T00:00:03.000Z',
    ];
    writeFileSync(
      handoffPath,
      [
        {
          timestamp: recoveryTimestamps[0],
          phase: 'recovery-started',
          error: 'candidate failed',
        },
        {
          timestamp: recoveryTimestamps[1],
          phase: 'last-known-good-restored',
          version: 'v0.0.1-e2e',
        },
        {
          timestamp: recoveryTimestamps[2],
          phase: 'last-known-good-launched',
          version: 'v0.0.1-e2e',
          pid: 1234,
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
    );

    const writeEvent = makeRunEventWriter(eventPath, 'run-1');
    writeEvent(
      {
        type: 'step.started',
        payload: { stepId: 'recover-replacement', name: 'Recover replacement' },
      },
      '2026-07-25T00:00:00.000Z'
    );
    for (const recovery of readRecoveryHandoffEvents(handoffPath)) {
      writeEvent(recovery.input, recovery.timestamp);
    }
    writeEvent(
      {
        type: 'artifact.created',
        payload: {
          artifactType: 'screenshot',
          path: 'artifacts/recover-replacement.png',
          stepId: 'recover-replacement',
        },
      },
      '2026-07-25T00:00:04.000Z'
    );
    writeEvent(
      {
        type: 'step.completed',
        payload: { stepId: 'recover-replacement', outcome: 'Passed' },
      },
      '2026-07-25T00:00:05.000Z'
    );
    writeEvent(
      { type: 'process.stopped', payload: { pid: 4321, leaked: false } },
      '2026-07-25T00:00:06.000Z'
    );
    writeEvent(
      { type: 'fixture.stopped', payload: { requests: 2 } },
      '2026-07-25T00:00:07.000Z'
    );

    const events = readRunEvents(eventPath);
    expect(events.map((value) => value.type)).toEqual([
      'step.started',
      'recovery.performed',
      'recovery.performed',
      'recovery.performed',
      'artifact.created',
      'step.completed',
      'process.stopped',
      'fixture.stopped',
    ]);
    expect(events.slice(1, 4).map((value) => value.timestamp)).toEqual(
      recoveryTimestamps
    );
  });

  test('replay reconstructs completed state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-replay-'));
    const path = join(directory, 'events.jsonl');
    const events = [
      event(1, 'run.started', { platform: 'linux' }),
      event(2, 'scenario.started', {
        scenarioId: 'application-visible-navigation',
        kind: 'Application Scenario',
      }),
      event(3, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 1,
      }),
      event(4, 'step.started', {
        stepId: 'navigate-discovery',
        name: 'Navigate to Discovery',
      }),
      event(5, 'artifact.created', {
        artifactType: 'screenshot',
        path: 'artifacts/navigate-discovery.png',
        stepId: 'navigate-discovery',
      }),
      event(6, 'step.completed', {
        stepId: 'navigate-discovery',
        outcome: 'Passed',
      }),
      event(7, 'attempt.completed', { attempt: 1, outcome: 'Passed' }),
      event(8, 'scenario.completed', {
        scenarioId: 'application-visible-navigation',
        outcome: 'Passed',
      }),
      event(9, 'run.completed', { outcome: 'Passed' }),
    ];
    writeFileSync(
      path,
      `${events.map((value) => JSON.stringify(value)).join('\n')}\n`
    );

    expect(replayRunEventLog(path)).toEqual({
      runId: 'run-1',
      outcome: 'Passed',
      completed: true,
      lastSequence: 9,
      scenarios: {
        'application-visible-navigation': {
          outcome: 'Passed',
          attempts: 1,
          completedSteps: ['navigate-discovery'],
          artifacts: ['artifacts/navigate-discovery.png'],
        },
      },
    });
  });

  test('replay retains both automatic-retry attempts and a distinct Flaky outcome', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-flaky-'));
    const path = join(directory, 'events.jsonl');
    const events = [
      event(1, 'run.started', { platform: 'linux' }),
      event(2, 'scenario.started', {
        scenarioId: 'application-visible-navigation',
        kind: 'Application Scenario',
      }),
      event(3, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 1,
      }),
      event(4, 'attempt.completed', { attempt: 1, outcome: 'Failed' }),
      event(5, 'retry.scheduled', {
        scenarioId: 'application-visible-navigation',
        fromAttempt: 1,
        toAttempt: 2,
        reason: 'first attempt failed',
      }),
      event(6, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 2,
      }),
      event(7, 'attempt.completed', { attempt: 2, outcome: 'Passed' }),
      event(8, 'scenario.completed', {
        scenarioId: 'application-visible-navigation',
        outcome: 'Flaky',
      }),
      event(9, 'run.completed', { outcome: 'Flaky' }),
    ];
    writeFileSync(
      path,
      `${events.map((value) => JSON.stringify(value)).join('\n')}\n`
    );

    expect(replayRunEventLog(path)).toMatchObject({
      outcome: 'Flaky',
      completed: true,
      scenarios: {
        'application-visible-navigation': {
          outcome: 'Flaky',
          attempts: 2,
        },
      },
    });
  });

  test('replay preserves deliberate assertion failure and its evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-failed-'));
    const path = join(directory, 'events.jsonl');
    const events = [
      event(1, 'run.started', { platform: 'linux' }),
      event(2, 'scenario.started', {
        scenarioId: 'application-visible-navigation',
        kind: 'Application Scenario',
      }),
      event(3, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 1,
      }),
      event(4, 'step.started', {
        stepId: 'navigate-discovery',
        name: 'Navigate to Discovery',
      }),
      event(5, 'artifact.created', {
        artifactType: 'screenshot',
        path: 'artifacts/failure.png',
        stepId: 'navigate-discovery',
      }),
      event(6, 'step.completed', {
        stepId: 'navigate-discovery',
        outcome: 'Failed',
        error: 'Deliberate Application Scenario assertion failure',
      }),
      event(7, 'artifact.created', {
        artifactType: 'main-log',
        path: 'artifacts/application-main.log',
      }),
      event(8, 'artifact.created', {
        artifactType: 'renderer-log',
        path: 'artifacts/application-renderer.log',
      }),
      event(9, 'attempt.completed', { attempt: 1, outcome: 'Failed' }),
      event(10, 'scenario.completed', {
        scenarioId: 'application-visible-navigation',
        outcome: 'Failed',
      }),
      event(11, 'run.completed', { outcome: 'Failed' }),
    ];
    writeFileSync(
      path,
      `${events.map((value) => JSON.stringify(value)).join('\n')}\n`
    );

    const replay = replayRunEventLog(path);
    expect(replay.outcome).toBe('Failed');
    expect(replay.scenarios['application-visible-navigation']).toEqual({
      outcome: 'Failed',
      attempts: 1,
      completedSteps: [],
      artifacts: [
        'artifacts/failure.png',
        'artifacts/application-main.log',
        'artifacts/application-renderer.log',
      ],
    });
  });

  test('replay infers Aborted without rewriting an unterminated log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-aborted-'));
    const path = join(directory, 'events.jsonl');
    const contents = `${JSON.stringify(
      event(1, 'run.started', { platform: 'linux' })
    )}\n${JSON.stringify(
      event(2, 'scenario.started', {
        scenarioId: 'application-visible-navigation',
        kind: 'Application Scenario',
      })
    )}\n`;
    writeFileSync(path, contents);

    expect(replayRunEventLog(path).outcome).toBe('Aborted');
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  test('HTML report exposes named steps, outcomes, errors, and artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-event-report-'));
    const path = join(directory, 'events.jsonl');
    mkdirSync(join(directory, 'artifacts'));
    writeFileSync(join(directory, 'artifacts', 'failure.png'), 'evidence');
    writeFileSync(
      path,
      [
        event(1, 'run.started', { platform: 'linux' }),
        event(2, 'scenario.started', {
          scenarioId: 'golden-journey',
          kind: 'Product Journey',
        }),
        event(3, 'step.started', {
          stepId: 'install-fixture',
          name: 'Install <fixture>',
        }),
        event(4, 'artifact.created', {
          artifactType: 'screenshot',
          path: 'artifacts/failure.png',
          stepId: 'install-fixture',
        }),
        event(5, 'step.completed', {
          stepId: 'install-fixture',
          outcome: 'Failed',
          error: 'Expected exactly one & received two',
        }),
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
    );

    const report = renderRunHtmlReport(path, 'Failed');
    expect(report).toContain('Install &lt;fixture&gt;');
    expect(report).toContain('Failed');
    expect(report).toContain('Expected exactly one &amp; received two');
    expect(report).toContain('href="artifacts/failure.png"');
    expect(report).toContain('artifacts/failure.png');
    const hrefs = [...report.matchAll(/href="([^"]+)"/g)].map(
      (match) => match[1]!
    );
    expect(hrefs).toContain('artifacts/failure.png');
    for (const href of hrefs) {
      expect(existsSync(join(directory, href))).toBe(true);
    }
  });
});
