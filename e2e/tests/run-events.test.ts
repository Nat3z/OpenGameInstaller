import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRunEvent,
  type RunEvent,
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
    expect(report).toContain('artifacts/failure.png');
  });
});
