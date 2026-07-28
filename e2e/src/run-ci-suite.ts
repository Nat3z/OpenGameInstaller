import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureWorkspaceBuilds } from '../../scripts/ensure-workspace-builds';
import {
  type BudgetMeasurement,
  CI_BUDGETS,
  CI_SUITES,
  type CiSuiteName,
  classifyCiCheckOutcome,
  classifyWorkspacePreparationOutcome,
  collectTopLevelArtifactTypes,
  collectTopLevelRunOutcomes,
  evaluateRunEventLogBudgets,
  renderCiHtmlSummary,
  renderCiSummary,
  resolveCiArtifactIdentity,
} from './ci-gates';
import { prepareLiveServiceEnvironment } from './live-service-scenarios';

const repositoryRoot = resolve(import.meta.dir, '../..');
const runRoot = resolve(
  process.env.OGI_E2E_RUN_ROOT ?? join(process.cwd(), '.e2e-ci-runs')
);

function listEventLogs(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listEventLogs(path);
    return entry.isFile() && entry.name === 'events.jsonl' ? [path] : [];
  });
}

function publishSummary() {
  const summaryPath = join(runRoot, 'ci-summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`CI summary is missing: ${summaryPath}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const markdown = renderCiSummary(summary);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, markdown);
  else process.stdout.write(markdown);
}

if (process.argv.includes('--publish')) {
  publishSummary();
} else {
  const suiteArgument = process.argv[2];
  const suiteName =
    suiteArgument === 'pull-request'
      ? ('pullRequest' as const)
      : suiteArgument === 'nightly' || suiteArgument === 'release'
        ? (suiteArgument as CiSuiteName)
        : undefined;
  if (!suiteName) {
    throw new Error(
      'CI suite must be one of: pull-request, nightly, release, or --publish'
    );
  }

  mkdirSync(runRoot, { recursive: true });
  const startedAt = Date.now();
  const jobBudgetMs =
    suiteName === 'pullRequest'
      ? CI_BUDGETS.pullRequestJobMs
      : CI_BUDGETS.fullJobMs;
  const checks: Array<{ id: string; outcome: string; elapsedMs: number }> = [];
  const budgetMeasurements: BudgetMeasurement[] = [];
  const budgetViolations: BudgetMeasurement[] = [];
  let failed = false;

  const prerequisiteStartedAt = Date.now();
  try {
    ensureWorkspaceBuilds(undefined, {
      timeoutMs: jobBudgetMs - (Date.now() - startedAt),
    });
  } catch (cause) {
    checks.push({
      id: 'workspace-prerequisites',
      outcome: classifyWorkspacePreparationOutcome(cause),
      elapsedMs: Date.now() - prerequisiteStartedAt,
    });
    process.stderr.write(
      `Workspace prerequisite build failed: ${cause instanceof Error ? cause.message : String(cause)}\n`
    );
    failed = true;
  }

  for (const entry of failed ? [] : CI_SUITES[suiteName]) {
    const elapsedBefore = Date.now() - startedAt;
    const remainingMs = jobBudgetMs - elapsedBefore;
    if (remainingMs <= 0) {
      checks.push({ id: entry.id, outcome: 'Failed', elapsedMs: 0 });
      failed = true;
      break;
    }
    const existingLogs = new Set(listEventLogs(runRoot));
    const checkStartedAt = Date.now();
    const [command, ...arguments_] = entry.command;
    const result = spawnSync(command!, arguments_, {
      cwd: repositoryRoot,
      env: {
        ...prepareLiveServiceEnvironment(process.env),
        OGI_E2E_RUN_ROOT: runRoot,
        OGI_E2E_DETERMINISTIC_ONLY: '1',
      },
      stdio: 'inherit',
      timeout: Math.min(remainingMs, entry.timeoutMs ?? remainingMs),
      killSignal: 'SIGTERM',
    });
    const elapsedMs = Date.now() - checkStartedAt;
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const newLogs = listEventLogs(runRoot).filter(
      (path) => !existingLogs.has(path)
    );
    let outcome = classifyCiCheckOutcome({
      status: result.status,
      timedOut,
      requiredArtifacts: entry.requiredArtifacts,
      observedArtifacts: collectTopLevelArtifactTypes(runRoot, newLogs),
      observedOutcomes: collectTopLevelRunOutcomes(runRoot, newLogs),
    });
    for (const eventLogPath of newLogs) {
      try {
        const budget = evaluateRunEventLogBudgets(
          eventLogPath,
          entry.id === 'golden-journey'
            ? 'golden-journey'
            : 'full-deterministic'
        );
        budgetMeasurements.push(...budget.measurements);
        budgetViolations.push(...budget.violations);
        if (!budget.passed) outcome = 'Failed';
      } catch (cause) {
        const invalidLogMeasurement: BudgetMeasurement = {
          budget: 'ordinary-ui-step',
          subject: `Invalid Run Event Log ${eventLogPath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          elapsedMs: 0,
          limitMs: CI_BUDGETS.ordinaryUiStepMs,
          passed: false,
        };
        budgetMeasurements.push(invalidLogMeasurement);
        budgetViolations.push(invalidLogMeasurement);
        outcome = 'Failed';
      }
    }
    checks.push({ id: entry.id, outcome, elapsedMs });
    if (outcome !== 'Passed') failed = true;
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > jobBudgetMs) failed = true;
  const { artifactName, artifactUrl } = resolveCiArtifactIdentity(
    process.env,
    process.platform,
    runRoot
  );
  const summary = {
    version: 1,
    suite: suiteArgument,
    platform: process.platform,
    elapsedMs,
    jobBudgetMs,
    artifactName,
    artifactUrl,
    deterministicOnly: true,
    runRoot,
    checks,
    budgetMeasurements,
    budgetViolations,
    outcome: failed ? 'Failed' : 'Passed',
  };
  writeFileSync(
    join(runRoot, 'ci-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  const markdown = renderCiSummary(summary);
  writeFileSync(join(runRoot, 'ci-summary.md'), markdown);
  writeFileSync(
    join(runRoot, 'ci-report.html'),
    renderCiHtmlSummary(summary, failed ? 'Failed' : 'Passed')
  );
  process.stdout.write(markdown);
  process.exitCode = failed ? 1 : 0;
}
