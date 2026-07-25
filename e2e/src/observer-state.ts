import {
  type RunEvent,
  TERMINAL_OUTCOMES,
  type TerminalOutcome,
} from './run-events';

export type ObserverArtifact = {
  type: Extract<
    RunEvent,
    { type: 'artifact.created' }
  >['payload']['artifactType'];
  path: string;
  stepId?: string;
};

export type ObserverStep = {
  id: string;
  name: string;
  startedAt: string;
  completedAt?: string;
  outcome?: 'Passed' | 'Failed';
  error?: string;
};

export type ObserverScenario = {
  id: string;
  kind: Extract<RunEvent, { type: 'scenario.started' }>['payload']['kind'];
  outcome: TerminalOutcome;
  attempts: number;
  steps: ObserverStep[];
};

export type ObserverState = {
  runId: string | null;
  status: 'Idle' | 'Running' | TerminalOutcome;
  outcome: TerminalOutcome | null;
  platform: NodeJS.Platform | null;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMilliseconds: number;
  activeStep: Pick<ObserverStep, 'id' | 'name' | 'startedAt'> | null;
  scenarios: ObserverScenario[];
  totals: Record<TerminalOutcome, number>;
  retries: number;
  artifacts: ObserverArtifact[];
  latestScreenshot: string | null;
  logs: string[];
  lastSequence: number;
};

export const emptyObserverState = (): ObserverState => ({
  runId: null,
  status: 'Idle',
  outcome: null,
  platform: null,
  startedAt: null,
  completedAt: null,
  elapsedMilliseconds: 0,
  activeStep: null,
  scenarios: [],
  totals: Object.fromEntries(
    TERMINAL_OUTCOMES.map((outcome) => [outcome, 0])
  ) as Record<TerminalOutcome, number>,
  retries: 0,
  artifacts: [],
  latestScreenshot: null,
  logs: [],
  lastSequence: 0,
});

export function reduceObserverEvents(
  events: readonly RunEvent[]
): ObserverState {
  if (events.length === 0) return emptyObserverState();

  const state = emptyObserverState();
  const scenarios = new Map<string, ObserverScenario>();
  let activeScenario: ObserverScenario | undefined;

  for (const event of events) {
    state.runId = event.runId;
    state.lastSequence = event.sequence;
    switch (event.type) {
      case 'run.started':
        state.status = 'Running';
        state.platform = event.payload.platform;
        state.startedAt = event.timestamp;
        break;
      case 'scenario.started': {
        activeScenario = {
          id: event.payload.scenarioId,
          kind: event.payload.kind,
          outcome: 'Aborted',
          attempts: 0,
          steps: [],
        };
        scenarios.set(activeScenario.id, activeScenario);
        break;
      }
      case 'attempt.started':
        if (activeScenario) {
          activeScenario.attempts = Math.max(
            activeScenario.attempts,
            event.payload.attempt
          );
        }
        break;
      case 'step.started':
        if (activeScenario) {
          const step = {
            id: event.payload.stepId,
            name: event.payload.name,
            startedAt: event.timestamp,
          };
          activeScenario.steps.push(step);
          state.activeStep = step;
        }
        break;
      case 'step.completed': {
        const step = activeScenario?.steps.findLast(
          (candidate) => candidate.id === event.payload.stepId
        );
        if (step) {
          step.completedAt = event.timestamp;
          step.outcome = event.payload.outcome;
          step.error = event.payload.error;
        }
        if (state.activeStep?.id === event.payload.stepId) {
          state.activeStep = null;
        }
        break;
      }
      case 'artifact.created': {
        const artifact: ObserverArtifact = {
          type: event.payload.artifactType,
          path: event.payload.path,
          stepId: event.payload.stepId,
        };
        state.artifacts.push(artifact);
        if (artifact.type === 'screenshot') {
          state.latestScreenshot = artifact.path;
        }
        if (artifact.type.endsWith('log')) state.logs.push(artifact.path);
        break;
      }
      case 'scenario.completed': {
        const scenario = scenarios.get(event.payload.scenarioId);
        if (scenario) scenario.outcome = event.payload.outcome;
        break;
      }
      case 'run.completed':
        state.status = event.payload.outcome;
        state.outcome = event.payload.outcome;
        state.completedAt = event.timestamp;
        state.activeStep = null;
        break;
      default:
        break;
    }
  }

  state.scenarios = [...scenarios.values()];
  state.retries = state.scenarios.reduce(
    (count, scenario) => count + Math.max(0, scenario.attempts - 1),
    0
  );
  for (const scenario of state.scenarios) state.totals[scenario.outcome]++;
  const started = state.startedAt ? Date.parse(state.startedAt) : 0;
  const ended = state.completedAt
    ? Date.parse(state.completedAt)
    : Date.parse(events.at(-1)!.timestamp);
  state.elapsedMilliseconds = Math.max(0, ended - started);
  return state;
}
