import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { RunEvent } from './run-events';

export const CI_BUDGETS = {
  ordinaryUiStepMs: 30_000,
  fixtureTransferStepMs: 120_000,
  goldenJourneyMs: 300_000,
  deterministicTorrentJourneyMs: 300_000,
  pullRequestJobMs: 600_000,
  fullJobMs: 1_500_000,
} as const;

export const CI_WORKFLOW_TIMEOUTS = {
  pullRequestMinutes: 15,
  fullMinutes: 35,
} as const;

export function collectTopLevelArtifactTypes(
  runRoot: string,
  eventLogPaths: readonly string[]
) {
  const artifactTypes: string[] = [];
  for (const eventLogPath of eventLogPaths) {
    if (relative(runRoot, eventLogPath).split(/[\\/]/).length !== 2) continue;
    for (const line of readFileSync(eventLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)) {
      const event = JSON.parse(line) as {
        type?: string;
        payload?: { artifactType?: string };
      };
      if (
        event.type === 'artifact.created' &&
        typeof event.payload?.artifactType === 'string'
      ) {
        artifactTypes.push(event.payload.artifactType);
      }
    }
  }
  return artifactTypes;
}

export type CiSuiteName = 'pullRequest' | 'nightly' | 'release';
export type CiRunKind = 'golden-journey' | 'full-deterministic';
export type CiBudgetName =
  | 'ordinary-ui-step'
  | 'fixture-transfer-step'
  | 'golden-journey';

export type CiSuiteEntry = {
  id: string;
  name: string;
  command: readonly string[];
  kind: 'deterministic' | 'quarantined';
  timeoutMs?: number;
  requiredArtifacts?: readonly string[];
};

const deterministic = (
  id: string,
  name: string,
  script: string,
  options: Pick<CiSuiteEntry, 'timeoutMs' | 'requiredArtifacts'> = {}
): CiSuiteEntry => ({
  id,
  name,
  command: ['bun', 'run', '--cwd', 'e2e', script],
  kind: 'deterministic',
  ...options,
});

const deterministicTorrent = () =>
  deterministic(
    'deterministic-torrent-installation',
    'Deterministic torrent installation',
    'ci:deterministic-torrent-installation',
    {
      timeoutMs: CI_BUDGETS.deterministicTorrentJourneyMs,
      requiredArtifacts: [
        'torrent-network-containment-assertion',
        'torrent-network-isolation-assertion',
        'torrent-payload-manifest-assertion',
      ],
    }
  );

export const CI_SUITES: Record<CiSuiteName, readonly CiSuiteEntry[]> = {
  pullRequest: [
    deterministic('accessibility', 'Accessibility gates', 'test:accessibility'),
    deterministic(
      'application-smoke',
      'Application Scenario smoke',
      'ci:application'
    ),
    deterministic('updater-smoke', 'Updater Scenario smoke', 'ci:updater'),
    deterministic('golden-journey', 'Golden Journey', 'ci:golden-journey'),
  ],
  nightly: [
    deterministic('accessibility', 'Accessibility gates', 'test:accessibility'),
    deterministic(
      'application-smoke',
      'Application Scenario smoke',
      'ci:application'
    ),
    deterministic('updater-smoke', 'Updater Scenario smoke', 'ci:updater'),
    deterministic('golden-journey', 'Golden Journey', 'ci:golden-journey'),
    deterministic(
      'last-known-good-recovery',
      'Last Known-Good recovery matrix',
      'ci:last-known-good-recovery'
    ),
    deterministic(
      'incremental-update',
      'Incremental update and full-download fallback matrix',
      'ci:incremental-update'
    ),
    deterministic(
      'interrupted-game-download-recovery',
      'Interrupted game download recovery',
      'ci:interrupted-game-download-recovery'
    ),
    deterministic(
      'fixture-game-lifecycle',
      'Fixture-game lifecycle',
      'ci:fixture-game-lifecycle'
    ),
    deterministic(
      'offline-product-behavior',
      'Offline product behavior',
      'ci:offline-product-behavior'
    ),
    deterministicTorrent(),
    {
      id: 'quarantined-scenarios',
      name: 'Quarantined scenario matrix',
      command: ['bun', 'run', '--cwd', 'e2e', 'ci:quarantined'],
      kind: 'quarantined',
    },
  ],
  release: [
    deterministic(
      'production-package-smoke',
      'Production release artifact smoke',
      'ci:production-package-smoke'
    ),
    deterministic('accessibility', 'Accessibility gates', 'test:accessibility'),
    deterministic(
      'application-smoke',
      'Application Scenario smoke',
      'ci:application'
    ),
    deterministic('updater-smoke', 'Updater Scenario smoke', 'ci:updater'),
    deterministic('golden-journey', 'Golden Journey', 'ci:golden-journey'),
    deterministic(
      'last-known-good-recovery',
      'Last Known-Good recovery matrix',
      'ci:last-known-good-recovery'
    ),
    deterministic(
      'incremental-update',
      'Incremental update and full-download fallback matrix',
      'ci:incremental-update'
    ),
    deterministic(
      'interrupted-game-download-recovery',
      'Interrupted game download recovery',
      'ci:interrupted-game-download-recovery'
    ),
    deterministic(
      'fixture-game-lifecycle',
      'Fixture-game lifecycle',
      'ci:fixture-game-lifecycle'
    ),
    deterministic(
      'offline-product-behavior',
      'Offline product behavior',
      'ci:offline-product-behavior'
    ),
    deterministicTorrent(),
  ],
};

export function classifyCiCheckOutcome(input: {
  status: number | null;
  timedOut: boolean;
  requiredArtifacts?: readonly string[];
  observedArtifacts?: readonly string[];
}) {
  if (input.timedOut) return 'Budget Failed';
  if (input.status !== 0) return 'Failed';
  const observed = new Set(input.observedArtifacts ?? []);
  if (
    input.requiredArtifacts?.some((artifactType) => !observed.has(artifactType))
  ) {
    return 'Failed';
  }
  return 'Passed';
}

const TRANSFER_STEP_IDS = new Set([
  'install-fixture',
  'interrupt-initial-download',
  'resume-interrupted-download',
]);

export type BudgetMeasurement = {
  budget: CiBudgetName;
  subject: string;
  elapsedMs: number;
  limitMs: number;
  passed: boolean;
};

function timestamp(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid Run Event timestamp: ${value}`);
  }
  return milliseconds;
}

export function evaluateRunEventBudgets(
  events: readonly RunEvent[],
  runKind: CiRunKind
) {
  const measurements: BudgetMeasurement[] = [];
  const startedSteps = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.type === 'step.started') {
      startedSteps.set(event.payload.stepId, event);
      continue;
    }
    if (event.type !== 'step.completed') continue;
    const started = startedSteps.get(event.payload.stepId);
    if (!started || started.type !== 'step.started') continue;
    const transfer = TRANSFER_STEP_IDS.has(event.payload.stepId);
    const limitMs = transfer
      ? CI_BUDGETS.fixtureTransferStepMs
      : CI_BUDGETS.ordinaryUiStepMs;
    const elapsedMs = timestamp(event.timestamp) - timestamp(started.timestamp);
    measurements.push({
      budget: transfer ? 'fixture-transfer-step' : 'ordinary-ui-step',
      subject: started.payload.name,
      elapsedMs,
      limitMs,
      passed: elapsedMs <= limitMs,
    });
  }

  if (runKind === 'golden-journey') {
    const runStarted = events.find((event) => event.type === 'run.started');
    const runCompleted = [...events]
      .reverse()
      .find((event) => event.type === 'run.completed');
    if (runStarted && runCompleted) {
      const elapsedMs =
        timestamp(runCompleted.timestamp) - timestamp(runStarted.timestamp);
      measurements.push({
        budget: 'golden-journey',
        subject: 'Golden Journey',
        elapsedMs,
        limitMs: CI_BUDGETS.goldenJourneyMs,
        passed: elapsedMs <= CI_BUDGETS.goldenJourneyMs,
      });
    }
  }

  const violations = measurements.filter((measurement) => !measurement.passed);
  return { passed: violations.length === 0, measurements, violations };
}

export function evaluateRunEventLogBudgets(path: string, runKind: CiRunKind) {
  const events = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return evaluateRunEventBudgets(events, runKind);
}

function duration(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type CiSummary = {
  suite: string;
  platform: string;
  elapsedMs: number;
  jobBudgetMs: number;
  artifactName: string;
  artifactUrl: string;
  checks: Array<{ id: string; outcome: string; elapsedMs: number }>;
  budgetMeasurements: BudgetMeasurement[];
  budgetViolations: BudgetMeasurement[];
};

export function resolveCiArtifactIdentity(
  environment: NodeJS.ProcessEnv,
  platform: string,
  runRoot: string
) {
  const artifactName =
    environment.OGI_E2E_ARTIFACT_NAME ?? `local-e2e-${platform}`;
  const artifactUrl =
    environment.OGI_E2E_ARTIFACT_URL ??
    (environment.GITHUB_SERVER_URL &&
    environment.GITHUB_REPOSITORY &&
    environment.GITHUB_RUN_ID
      ? `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}/artifacts`
      : `file://${runRoot}`);
  return { artifactName, artifactUrl };
}

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderCiHtmlSummary(summary: CiSummary, outcome: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenGameInstaller E2E CI report</title></head><body><main><h1>E2E ${htmlEscape(summary.suite)}</h1><p>Platform: ${htmlEscape(summary.platform)}</p><p>Outcome: ${htmlEscape(outcome)}</p><p>Elapsed: ${summary.elapsedMs} ms; budget: ${summary.jobBudgetMs} ms</p><p>Retained artifact: <a href="${htmlEscape(summary.artifactUrl)}">${htmlEscape(summary.artifactName)}</a></p><h2>Checks</h2><ul>${summary.checks.map((check) => `<li>${htmlEscape(check.id)}: ${htmlEscape(check.outcome)} (${check.elapsedMs} ms)</li>`).join('')}</ul><h2>Runtime budgets</h2><ul>${summary.budgetMeasurements.map((measurement) => `<li>${htmlEscape(measurement.budget)} — ${htmlEscape(measurement.subject)}: ${measurement.elapsedMs} / ${measurement.limitMs} ms (${measurement.passed ? 'Passed' : 'Failed'})</li>`).join('')}</ul><h2>Budget violations</h2><ul>${summary.budgetViolations.map((violation) => `<li>${htmlEscape(violation.subject)}: ${violation.elapsedMs} ms exceeded ${violation.limitMs} ms</li>`).join('')}</ul></main></body></html>\n`;
}

export function renderCiSummary(summary: CiSummary) {
  const names = new Map(
    Object.values(CI_SUITES)
      .flat()
      .map((entry) => [entry.id, entry.name])
  );
  const lines = [
    `## E2E ${summary.suite} — ${summary.platform}`,
    '',
    `Job elapsed: ${duration(summary.elapsedMs)} / ${duration(summary.jobBudgetMs)}`,
    '',
    '| Check | Outcome | Elapsed |',
    '| --- | --- | ---: |',
    ...summary.checks.map(
      (check) =>
        `| ${names.get(check.id) ?? check.id} | ${check.outcome} | ${duration(check.elapsedMs)} |`
    ),
  ];
  if (summary.budgetMeasurements.length > 0) {
    lines.push(
      '',
      '### Runtime budgets',
      '',
      '| Budget | Subject | Elapsed / limit | Outcome |',
      '| --- | --- | ---: | --- |',
      ...summary.budgetMeasurements.map(
        (measurement) =>
          `| ${measurement.budget} | ${measurement.subject} | ${duration(measurement.elapsedMs)} / ${duration(measurement.limitMs)} | ${measurement.passed ? 'Passed' : 'Failed'} |`
      )
    );
  }
  if (summary.budgetViolations.length > 0) {
    lines.push('', '### Budget violations');
    for (const violation of summary.budgetViolations) {
      lines.push(
        `- ${violation.subject}: ${duration(violation.elapsedMs)} exceeded ${duration(violation.limitMs)} (${violation.budget})`
      );
    }
  }
  lines.push(
    '',
    `Retained artifact: [${summary.artifactName}](${summary.artifactUrl})`
  );
  return `${lines.join('\n')}\n`;
}
