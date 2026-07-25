import { appendFileSync, readFileSync } from 'node:fs';
import { Data } from 'effect';

export const TERMINAL_OUTCOMES = [
  'Passed',
  'Failed',
  'Flaky',
  'Skipped',
  'Cancelled',
  'Aborted',
  'Infrastructure Failed',
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

type EventPayloads = {
  'run.started': { platform: NodeJS.Platform };
  'scenario.started': {
    scenarioId: string;
    kind: 'Application Scenario' | 'Updater Scenario' | 'Product Journey';
  };
  'attempt.started': { scenarioId: string; attempt: number };
  'step.started': { stepId: string; name: string };
  'artifact.created': {
    artifactType:
      | 'screenshot'
      | 'main-log'
      | 'renderer-log'
      | 'updater-main-log'
      | 'updater-renderer-log'
      | 'fixture-requests'
      | 'native-dialog-requests'
      | 'run-descriptor'
      | 'handoff-log'
      | 'startup-health';
    path: string;
    stepId?: string;
  };
  'fixture.started': { port: number };
  'fixture.request': { method: string; path: string; status: number };
  'fixture.stopped': { requests: number };
  'native-dialog.request': {
    action: string;
    kind: string;
    response: number;
  };
  'process.started': { pid: number; name: string };
  'process.stopped': { pid: number; leaked: boolean };
  'step.completed': {
    stepId: string;
    outcome: 'Passed' | 'Failed';
    error?: string;
  };
  'attempt.completed': { attempt: number; outcome: TerminalOutcome };
  'scenario.completed': { scenarioId: string; outcome: TerminalOutcome };
  'run.completed': { outcome: TerminalOutcome };
};

export type RunEvent = {
  [Type in keyof EventPayloads]: {
    version: 1;
    runId: string;
    sequence: number;
    timestamp: string;
    type: Type;
    payload: EventPayloads[Type];
  };
}[keyof EventPayloads];

export type RunEventInput = {
  [Type in keyof EventPayloads]: {
    type: Type;
    payload: EventPayloads[Type];
  };
}[keyof EventPayloads];

export class RunEventValidationError extends Data.TaggedError(
  'RunEventValidationError'
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message() {
    return this.detail;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0;
const isOutcome = (value: unknown): value is TerminalOutcome =>
  isString(value) && TERMINAL_OUTCOMES.includes(value as TerminalOutcome);

function requireKeys(
  type: string,
  payload: Record<string, unknown>,
  required: string[],
  optional: string[] = []
) {
  for (const key of required) {
    if (!(key in payload)) {
      throw new RunEventValidationError({
        detail: `${type} payload is missing ${key}`,
      });
    }
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RunEventValidationError({
      detail: `${type} payload has unknown fields: ${unknown.join(', ')}`,
    });
  }
}

function validatePayload(type: string, payload: Record<string, unknown>) {
  switch (type) {
    case 'run.started':
      requireKeys(type, payload, ['platform']);
      if (!isString(payload.platform))
        throw new Error('platform must be a string');
      return;
    case 'scenario.started':
      requireKeys(type, payload, ['scenarioId', 'kind']);
      if (
        !isString(payload.scenarioId) ||
        ![
          'Application Scenario',
          'Updater Scenario',
          'Product Journey',
        ].includes(String(payload.kind))
      )
        throw new Error('scenarioId or kind is invalid');
      return;
    case 'attempt.started':
      requireKeys(type, payload, ['scenarioId', 'attempt']);
      if (!isString(payload.scenarioId) || !isPositiveInteger(payload.attempt))
        throw new Error('scenarioId or attempt is invalid');
      return;
    case 'step.started':
      requireKeys(type, payload, ['stepId', 'name']);
      if (!isString(payload.stepId) || !isString(payload.name))
        throw new Error('stepId or name is invalid');
      return;
    case 'artifact.created':
      requireKeys(type, payload, ['artifactType', 'path'], ['stepId']);
      if (
        !isString(payload.artifactType) ||
        ![
          'screenshot',
          'main-log',
          'renderer-log',
          'updater-main-log',
          'updater-renderer-log',
          'fixture-requests',
          'native-dialog-requests',
          'run-descriptor',
          'handoff-log',
          'startup-health',
        ].includes(payload.artifactType) ||
        !isString(payload.path) ||
        payload.path.length === 0
      )
        throw new Error('artifactType or path is invalid');
      if (payload.stepId !== undefined && !isString(payload.stepId))
        throw new Error('stepId is invalid');
      return;
    case 'fixture.started':
      requireKeys(type, payload, ['port']);
      if (!isPositiveInteger(payload.port)) throw new Error('port is invalid');
      return;
    case 'fixture.request':
      requireKeys(type, payload, ['method', 'path', 'status']);
      if (
        !isString(payload.method) ||
        !isString(payload.path) ||
        !isPositiveInteger(payload.status)
      )
        throw new Error('fixture request payload is invalid');
      return;
    case 'fixture.stopped':
      requireKeys(type, payload, ['requests']);
      if (!Number.isInteger(payload.requests) || Number(payload.requests) < 0)
        throw new Error('request count is invalid');
      return;
    case 'native-dialog.request':
      requireKeys(type, payload, ['action', 'kind', 'response']);
      if (
        !isString(payload.action) ||
        !isString(payload.kind) ||
        !Number.isInteger(payload.response) ||
        Number(payload.response) < 0
      )
        throw new Error('native-dialog request payload is invalid');
      return;
    case 'process.started':
      requireKeys(type, payload, ['pid', 'name']);
      if (!isPositiveInteger(payload.pid) || !isString(payload.name))
        throw new Error('pid or name is invalid');
      return;
    case 'process.stopped':
      requireKeys(type, payload, ['pid', 'leaked']);
      if (
        !isPositiveInteger(payload.pid) ||
        typeof payload.leaked !== 'boolean'
      )
        throw new Error('pid or leaked is invalid');
      return;
    case 'step.completed':
      requireKeys(type, payload, ['stepId', 'outcome'], ['error']);
      if (
        !isString(payload.stepId) ||
        !['Passed', 'Failed'].includes(String(payload.outcome)) ||
        (payload.error !== undefined && !isString(payload.error))
      )
        throw new Error('step completion payload is invalid');
      return;
    case 'attempt.completed':
      requireKeys(type, payload, ['attempt', 'outcome']);
      if (!isPositiveInteger(payload.attempt) || !isOutcome(payload.outcome))
        throw new Error('attempt completion payload is invalid');
      return;
    case 'scenario.completed':
      requireKeys(type, payload, ['scenarioId', 'outcome']);
      if (!isString(payload.scenarioId) || !isOutcome(payload.outcome))
        throw new Error('scenario completion payload is invalid');
      return;
    case 'run.completed':
      requireKeys(type, payload, ['outcome']);
      if (!isOutcome(payload.outcome)) throw new Error('outcome is invalid');
      return;
    default:
      throw new RunEventValidationError({
        detail: `Unknown event type: ${type}`,
      });
  }
}

export function parseRunEvent(value: unknown): RunEvent {
  try {
    if (!isRecord(value)) throw new Error('event must be an object');
    requireKeys('event', value, [
      'version',
      'runId',
      'sequence',
      'timestamp',
      'type',
      'payload',
    ]);
    if (value.version !== 1) throw new Error('version must be 1');
    if (!isString(value.runId) || value.runId.length === 0)
      throw new Error('runId must be a non-empty string');
    if (!isPositiveInteger(value.sequence))
      throw new Error('sequence must be a positive integer');
    if (!isString(value.timestamp) || Number.isNaN(Date.parse(value.timestamp)))
      throw new Error('timestamp must be ISO-8601');
    if (!isString(value.type)) throw new Error('type must be a string');
    if (!isRecord(value.payload)) throw new Error('payload must be an object');
    validatePayload(value.type, value.payload);
    return value as RunEvent;
  } catch (cause) {
    if (cause instanceof RunEventValidationError) throw cause;
    throw new RunEventValidationError({
      detail: `${isRecord(value) && isString(value.type) ? value.type : 'event'}: ${(cause as Error).message}`,
      cause,
    });
  }
}

export function appendRunEvent(path: string, event: RunEvent) {
  const validated = parseRunEvent(event);
  appendFileSync(path, `${JSON.stringify(validated)}\n`, { encoding: 'utf8' });
}

export function makeRunEventWriter(
  path: string,
  runId: string,
  startSequence = 0
) {
  let sequence = startSequence;
  return (input: RunEventInput) => {
    const event = parseRunEvent({
      version: 1,
      runId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      ...input,
    });
    appendRunEvent(path, event);
    return event;
  };
}

type ScenarioReplay = {
  outcome: TerminalOutcome;
  attempts: number;
  completedSteps: string[];
  artifacts: string[];
};

export function readRunEvents(path: string): RunEvent[] {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new RunEventValidationError({ detail: 'Run Event Log is empty' });
  }
  return lines.map((line, index) => {
    try {
      return parseRunEvent(JSON.parse(line));
    } catch (cause) {
      throw new RunEventValidationError({
        detail: `Invalid event at line ${index + 1}`,
        cause,
      });
    }
  });
}

export function replayRunEventLog(path: string): {
  runId: string;
  outcome: TerminalOutcome;
  completed: boolean;
  lastSequence: number;
  scenarios: Record<string, ScenarioReplay>;
} {
  const events = readRunEvents(path);
  const runId = events[0]!.runId;
  const scenarios: Record<string, ScenarioReplay> = {};
  let activeScenarioId: string | undefined;
  let expectedSequence = 1;
  let completed = false;
  let outcome: TerminalOutcome = 'Aborted';

  for (const event of events) {
    if (event.runId !== runId || event.sequence !== expectedSequence++) {
      throw new RunEventValidationError({
        detail: `Run ID or sequence mismatch at sequence ${event.sequence}`,
      });
    }
    if (event.type === 'scenario.started') {
      activeScenarioId = event.payload.scenarioId;
      scenarios[activeScenarioId] = {
        outcome: 'Aborted',
        attempts: 0,
        completedSteps: [],
        artifacts: [],
      };
    } else if (event.type === 'attempt.started' && activeScenarioId) {
      scenarios[activeScenarioId]!.attempts = Math.max(
        scenarios[activeScenarioId]!.attempts,
        event.payload.attempt
      );
    } else if (event.type === 'step.completed' && activeScenarioId) {
      if (event.payload.outcome === 'Passed') {
        scenarios[activeScenarioId]!.completedSteps.push(event.payload.stepId);
      }
    } else if (event.type === 'artifact.created' && activeScenarioId) {
      scenarios[activeScenarioId]!.artifacts.push(event.payload.path);
    } else if (event.type === 'scenario.completed') {
      scenarios[event.payload.scenarioId]!.outcome = event.payload.outcome;
    } else if (event.type === 'run.completed') {
      completed = true;
      outcome = event.payload.outcome;
    }
  }

  return {
    runId,
    outcome,
    completed,
    lastSequence: events.at(-1)!.sequence,
    scenarios,
  };
}
