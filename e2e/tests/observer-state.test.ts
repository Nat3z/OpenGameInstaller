import { describe, expect, test } from 'bun:test';
import { reduceObserverEvents } from '../src/observer-state';
import type { RunEvent } from '../src/run-events';

const event = <Type extends RunEvent['type']>(
  sequence: number,
  type: Type,
  payload: Extract<RunEvent, { type: Type }>['payload'],
  seconds = sequence
): Extract<RunEvent, { type: Type }> =>
  ({
    version: 1,
    runId: 'observer-run',
    sequence,
    timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, seconds)).toISOString(),
    type,
    payload,
  }) as Extract<RunEvent, { type: Type }>;

describe('Observer Window state', () => {
  test('reconstructs active progress, evidence, retries, and elapsed time', () => {
    const events: RunEvent[] = [
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
      event(5, 'step.completed', {
        stepId: 'navigate-discovery',
        outcome: 'Failed',
        error: 'first attempt failed',
      }),
      event(6, 'attempt.completed', { attempt: 1, outcome: 'Failed' }),
      event(7, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 2,
      }),
      event(8, 'step.started', {
        stepId: 'navigate-discovery',
        name: 'Navigate to Discovery',
      }),
      event(9, 'artifact.created', {
        artifactType: 'screenshot',
        path: 'artifacts/navigate-discovery.png',
        stepId: 'navigate-discovery',
      }),
      event(10, 'artifact.created', {
        artifactType: 'main-log',
        path: 'artifacts/application-main.log',
      }),
    ];

    expect(reduceObserverEvents(events)).toMatchObject({
      runId: 'observer-run',
      status: 'Running',
      elapsedMilliseconds: 9_000,
      retries: 1,
      activeStep: {
        id: 'navigate-discovery',
        name: 'Navigate to Discovery',
      },
      latestScreenshot: 'artifacts/navigate-discovery.png',
      artifacts: [
        {
          type: 'screenshot',
          path: 'artifacts/navigate-discovery.png',
        },
        {
          type: 'main-log',
          path: 'artifacts/application-main.log',
        },
      ],
      logs: ['artifacts/application-main.log'],
      totals: {
        Passed: 0,
        Failed: 0,
        Flaky: 0,
        Skipped: 0,
        Cancelled: 0,
        Aborted: 1,
        'Infrastructure Failed': 0,
      },
    });
  });

  test('reconstructs a completed Cancelled run without treating it as failure', () => {
    const events: RunEvent[] = [
      event(1, 'run.started', { platform: 'linux' }),
      event(2, 'scenario.started', {
        scenarioId: 'application-visible-navigation',
        kind: 'Application Scenario',
      }),
      event(3, 'attempt.started', {
        scenarioId: 'application-visible-navigation',
        attempt: 1,
      }),
      event(4, 'attempt.completed', { attempt: 1, outcome: 'Cancelled' }),
      event(5, 'scenario.completed', {
        scenarioId: 'application-visible-navigation',
        outcome: 'Cancelled',
      }),
      event(6, 'run.completed', { outcome: 'Cancelled' }),
    ];

    expect(reduceObserverEvents(events)).toMatchObject({
      status: 'Cancelled',
      outcome: 'Cancelled',
      activeStep: null,
      totals: {
        Passed: 0,
        Failed: 0,
        Flaky: 0,
        Skipped: 0,
        Cancelled: 1,
        Aborted: 0,
        'Infrastructure Failed': 0,
      },
    });
  });
});
