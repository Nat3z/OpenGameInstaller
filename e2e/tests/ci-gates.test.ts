import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CI_BUDGETS,
  CI_SUITES,
  CI_WORKFLOW_TIMEOUTS,
  type CiSummary,
  classifyCiCheckOutcome,
  classifyWorkspacePreparationOutcome,
  collectTopLevelArtifactTypes,
  collectTopLevelRunOutcomes,
  evaluateRunEventBudgets,
  getObserverCatalog,
  getObserverCheckCatalog,
  renderCiHtmlSummary,
  renderCiSummary,
  resolveCiArtifactIdentity,
  resolveObserverSelection,
} from '../src/ci-gates';
import type { RunEvent } from '../src/run-events';

const repositoryRoot = join(import.meta.dir, '../..');

function event(
  sequence: number,
  timestamp: string,
  type: 'run.started' | 'step.started' | 'step.completed' | 'run.completed',
  payload: Record<string, unknown>
) {
  return {
    version: 1 as const,
    runId: 'run-1',
    sequence,
    timestamp,
    type,
    payload,
  } as RunEvent;
}

describe('CI and release gates', () => {
  test('defines the agreed UI, transfer, journey, PR, and full-suite budgets', () => {
    expect(CI_BUDGETS).toEqual({
      ordinaryUiStepMs: 30_000,
      fixtureTransferStepMs: 120_000,
      goldenJourneyMs: 300_000,
      deterministicTorrentJourneyMs: 300_000,
      pullRequestJobMs: 600_000,
      fullJobMs: 1_500_000,
    });
  });

  test('keeps workflow timeouts above internally enforced job budgets', () => {
    expect(CI_WORKFLOW_TIMEOUTS.pullRequestMinutes * 60_000).toBeGreaterThan(
      CI_BUDGETS.pullRequestJobMs
    );
    expect(CI_WORKFLOW_TIMEOUTS.fullMinutes * 60_000).toBeGreaterThan(
      CI_BUDGETS.fullJobMs
    );
  });

  test('classifies workspace preparation failures with the spec outcome', () => {
    expect(
      classifyWorkspacePreparationOutcome(
        Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      )
    ).toBe('Failed');
    expect(classifyWorkspacePreparationOutcome(new Error('build failed'))).toBe(
      'Failed'
    );
  });

  test('fails and reports ordinary UI, transfer, and Golden Journey overruns', () => {
    const events = [
      event(1, '2026-07-25T00:00:00.000Z', 'run.started', {
        platform: 'linux',
      }),
      event(2, '2026-07-25T00:00:01.000Z', 'step.started', {
        stepId: 'navigate-discovery',
        name: 'Navigate to Discovery',
      }),
      event(3, '2026-07-25T00:00:32.000Z', 'step.completed', {
        stepId: 'navigate-discovery',
        outcome: 'Passed',
      }),
      event(4, '2026-07-25T00:00:33.000Z', 'step.started', {
        stepId: 'install-fixture',
        name: 'Install fixture',
      }),
      event(5, '2026-07-25T00:02:34.000Z', 'step.completed', {
        stepId: 'install-fixture',
        outcome: 'Passed',
      }),
      event(6, '2026-07-25T00:05:01.000Z', 'run.completed', {
        outcome: 'Passed',
      }),
    ];

    const result = evaluateRunEventBudgets(events, 'golden-journey');
    expect(result.passed).toBe(false);
    expect(
      result.measurements.map((measurement) => measurement.budget)
    ).toEqual(['ordinary-ui-step', 'fixture-transfer-step', 'golden-journey']);
    expect(result.violations).toHaveLength(3);
  });

  test('keeps transfer steps out of the stricter ordinary UI budget', () => {
    const events = [
      event(1, '2026-07-25T00:00:00.000Z', 'run.started', {
        platform: 'linux',
      }),
      event(2, '2026-07-25T00:00:01.000Z', 'step.started', {
        stepId: 'resume-interrupted-download',
        name: 'Resume fixture download',
      }),
      event(3, '2026-07-25T00:01:30.000Z', 'step.completed', {
        stepId: 'resume-interrupted-download',
        outcome: 'Passed',
      }),
      event(4, '2026-07-25T00:02:00.000Z', 'run.completed', {
        outcome: 'Passed',
      }),
    ];

    const result = evaluateRunEventBudgets(events, 'full-deterministic');
    expect(result.passed).toBe(true);
    expect(result.measurements[0]?.budget).toBe('fixture-transfer-step');
  });

  test('defines required, nightly, and release suites without Live Service Scenarios', () => {
    expect(CI_SUITES.pullRequest.map((entry) => entry.id)).toEqual([
      'accessibility',
      'application-smoke',
      'updater-smoke',
      'golden-journey',
    ]);
    expect(CI_SUITES.nightly.map((entry) => entry.id)).toContain(
      'last-known-good-recovery'
    );
    expect(CI_SUITES.nightly.map((entry) => entry.id)).toContain(
      'quarantined-scenarios'
    );
    expect(CI_SUITES.release.map((entry) => entry.id)).toContain(
      'production-package-smoke'
    );
    expect(CI_SUITES.release.map((entry) => entry.id)).toContain(
      'offline-product-behavior'
    );
    for (const suiteName of ['nightly', 'release'] as const) {
      const torrent = CI_SUITES[suiteName].find(
        (entry) => entry.id === 'deterministic-torrent-installation'
      );
      expect(torrent).toEqual(
        expect.objectContaining({
          command: [
            'bun',
            'run',
            '--cwd',
            'e2e',
            'ci:deterministic-torrent-installation',
          ],
          timeoutMs: CI_BUDGETS.deterministicTorrentJourneyMs,
          requiredArtifacts: [
            'torrent-network-containment-assertion',
            'torrent-network-isolation-assertion',
            'torrent-payload-manifest-assertion',
          ],
        })
      );
    }
    expect(
      CI_SUITES.pullRequest.some(
        (entry) => entry.id === 'deterministic-torrent-installation'
      )
    ).toBe(false);
    for (const suite of Object.values(CI_SUITES)) {
      expect(suite.some((entry) => String(entry.kind) === 'live-service')).toBe(
        false
      );
    }
  });

  test('exposes presets and every deterministic check to the Observer', () => {
    const checks = getObserverCheckCatalog();
    const catalog = getObserverCatalog();
    const expectedCheckIds = [
      ...new Set(
        Object.values(CI_SUITES).flatMap((suite) =>
          suite.map((entry) => entry.id)
        )
      ),
    ];

    expect(checks.map((entry) => entry.id)).toEqual(expectedCheckIds);
    expect(catalog.filter((entry) => entry.type === 'preset')).toHaveLength(3);
    expect(
      catalog
        .filter((entry) => entry.type === 'check')
        .map((entry) => String(entry.id))
    ).toEqual(expectedCheckIds.map((id) => `check:${id}`));
    expect(
      resolveObserverSelection('preset:pull-request')?.map((entry) => entry.id)
    ).toEqual(CI_SUITES.pullRequest.map((entry) => entry.id));
    expect(
      resolveObserverSelection('check:golden-journey')?.map((entry) => entry.id)
    ).toEqual(['golden-journey']);
    expect(resolveObserverSelection('check:live-service')).toBeUndefined();
  });

  test('discovers required torrent assertions from the aggregate event log only', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'ogi-ci-artifacts-'));
    const aggregateDirectory = join(runRoot, 'product-journey-reliable-run');
    const nestedAttemptDirectory = join(aggregateDirectory, 'attempt-1');
    mkdirSync(nestedAttemptDirectory, { recursive: true });
    const aggregateEventPath = join(aggregateDirectory, 'events.jsonl');
    const nestedEventPath = join(nestedAttemptDirectory, 'events.jsonl');
    const artifactTypes = [
      'torrent-network-containment-assertion',
      'torrent-network-isolation-assertion',
      'torrent-payload-manifest-assertion',
    ];
    writeFileSync(
      aggregateEventPath,
      artifactTypes
        .map((artifactType, index) =>
          JSON.stringify({
            version: 1,
            runId: 'aggregate-run',
            sequence: index + 1,
            timestamp: '2026-07-26T00:00:00.000Z',
            type: 'artifact.created',
            payload: {
              artifactType,
              path: `attempt-1/artifacts/${artifactType}.json`,
              attempt: 1,
            },
          })
        )
        .join('\n')
    );
    writeFileSync(
      nestedEventPath,
      JSON.stringify({
        type: 'artifact.created',
        payload: { artifactType: 'nested-only-artifact' },
      })
    );

    expect(
      collectTopLevelArtifactTypes(runRoot, [
        nestedEventPath,
        aggregateEventPath,
      ])
    ).toEqual(artifactTypes);
  });

  test('honors a top-level Flaky Run Event outcome when the command exits zero', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'ogi-ci-outcome-'));
    const aggregateDirectory = join(runRoot, 'application-reliable-run');
    mkdirSync(aggregateDirectory, { recursive: true });
    const eventPath = join(aggregateDirectory, 'events.jsonl');
    writeFileSync(
      eventPath,
      `${JSON.stringify({
        type: 'run.completed',
        payload: { outcome: 'Flaky' },
      })}\n`
    );

    const observedOutcomes = collectTopLevelRunOutcomes(runRoot, [eventPath]);
    expect(observedOutcomes).toEqual(['Flaky']);
    expect(
      classifyCiCheckOutcome({
        status: 0,
        timedOut: false,
        observedOutcomes,
      })
    ).toBe('Flaky');
  });

  test('propagates torrent command failures, timeouts, and missing evidence', () => {
    const requiredArtifacts = [
      'torrent-network-containment-assertion',
      'torrent-network-isolation-assertion',
      'torrent-payload-manifest-assertion',
    ];
    expect(
      classifyCiCheckOutcome({
        status: 1,
        timedOut: false,
        requiredArtifacts,
        observedArtifacts: requiredArtifacts,
      })
    ).toBe('Failed');
    expect(
      classifyCiCheckOutcome({
        status: null,
        timedOut: true,
        requiredArtifacts,
        observedArtifacts: requiredArtifacts,
      })
    ).toBe('Failed');
    expect(
      classifyCiCheckOutcome({
        status: 0,
        timedOut: false,
        requiredArtifacts,
        observedArtifacts: ['torrent-network-containment-assertion'],
      })
    ).toBe('Failed');
    expect(
      classifyCiCheckOutcome({
        status: 0,
        timedOut: false,
        requiredArtifacts,
        observedArtifacts: requiredArtifacts,
      })
    ).toBe('Passed');
  });

  test('persists stable artifact identity in Markdown and HTML reports', () => {
    const report = {
      suite: 'pull-request',
      platform: 'linux',
      elapsedMs: 1250,
      jobBudgetMs: CI_BUDGETS.pullRequestJobMs,
      artifactName: 'required-e2e-ubuntu-latest',
      artifactUrl: 'https://example.invalid/artifact/1',
      checks: [{ id: 'golden-journey', outcome: 'Passed', elapsedMs: 1000 }],
      budgetMeasurements: [
        {
          budget: 'golden-journey',
          subject: 'Golden Journey',
          elapsedMs: 1000,
          limitMs: CI_BUDGETS.goldenJourneyMs,
          passed: true,
        },
      ],
      budgetViolations: [],
    } satisfies CiSummary;
    const markdown = renderCiSummary(report);
    const html = renderCiHtmlSummary(report, 'Passed');
    expect(markdown).toContain(
      '[required-e2e-ubuntu-latest](https://example.invalid/artifact/1)'
    );
    expect(markdown).toContain('Golden Journey');
    expect(markdown).toContain('Runtime budgets');
    expect(markdown).toContain('5m 0s');
    expect(markdown).toContain('10m 0s');
    expect(html).toContain(
      '<a href="https://example.invalid/artifact/1">required-e2e-ubuntu-latest</a>'
    );
    expect(
      resolveCiArtifactIdentity(
        {
          GITHUB_SERVER_URL: 'https://github.example',
          GITHUB_REPOSITORY: 'owner/repository',
          GITHUB_RUN_ID: '42',
          OGI_E2E_ARTIFACT_NAME: 'nightly-e2e-windows-latest',
        },
        'win32',
        '/runs'
      )
    ).toEqual({
      artifactName: 'nightly-e2e-windows-latest',
      artifactUrl:
        'https://github.example/owner/repository/actions/runs/42/artifacts',
    });
  });

  test('builds generated workspace package entries before application and fixture consumers', () => {
    const applicationPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'application/package.json'), 'utf8')
    );
    const e2ePackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'e2e/package.json'), 'utf8')
    );

    const rootPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8')
    );
    const ciSuiteSource = readFileSync(
      join(repositoryRoot, 'e2e/src/run-ci-suite.ts'),
      'utf8'
    );

    expect(rootPackage.scripts['ensure:workspace-builds']).toBe(
      'bun run scripts/ensure-workspace-builds.ts'
    );
    expect(applicationPackage.scripts.prebuild).toBe(
      'bun run --cwd .. ensure:workspace-builds'
    );
    expect(rootPackage.scripts.build).toBe(
      'bun run ensure:workspace-builds --force'
    );
    expect(applicationPackage.scripts['build:all']).toBe(
      'bun run --cwd .. ensure:workspace-builds --force'
    );
    expect(e2ePackage.dependencies['ogi-addon']).toBe('workspace:*');
    expect(e2ePackage.scripts['build:fixture-addon']).toStartWith(
      'bun run prepare:workspace-packages && '
    );
    expect(e2ePackage.scripts['build:fixture-addon:main']).toStartWith(
      'bun run --cwd .. ensure:workspace-builds ogi-addon && '
    );
    expect(
      ciSuiteSource.indexOf('ensureWorkspaceBuilds(undefined')
    ).toBeLessThan(ciSuiteSource.indexOf('for (const entry'));
    expect(ciSuiteSource).toContain(
      'timeoutMs: jobBudgetMs - (Date.now() - startedAt)'
    );
    expect(ciSuiteSource).toContain(
      'outcome: classifyWorkspacePreparationOutcome(cause)'
    );
    expect(ciSuiteSource.indexOf('workspace-prerequisites')).toBeLessThan(
      ciSuiteSource.lastIndexOf("join(runRoot, 'ci-summary.json')")
    );
  });

  test('configures Windows and Linux PR, nightly, and release workflows with hard job budgets and artifact publication', () => {
    const required = readFileSync(
      join(repositoryRoot, '.github/workflows/e2e-required.yml'),
      'utf8'
    );
    const scheduled = readFileSync(
      join(repositoryRoot, '.github/workflows/e2e-full.yml'),
      'utf8'
    );
    const release = readFileSync(
      join(repositoryRoot, '.github/workflows/build-release.yml'),
      'utf8'
    );

    expect(required).toContain('os: [ubuntu-latest, windows-latest]');
    expect(required).toContain(
      `timeout-minutes: ${CI_WORKFLOW_TIMEOUTS.pullRequestMinutes}`
    );
    expect(required.split('permissions:')[0]).not.toContain('matrix.');
    expect(required).toContain('bun run ci:pull-request');
    expect(required).toContain('actions/upload-artifact@v4');
    expect(required).toContain('include-hidden-files: true');
    expect(required).toContain('if: always()');
    expect(required).toContain(
      'OGI_E2E_RUN_ROOT: $' + '{{ github.workspace }}/.e2e-ci-runs'
    );
    expect(required).toContain('OGI_E2E_ARTIFACT_NAME: required-e2e-');

    expect(scheduled).toContain('schedule:');
    expect(scheduled).toContain('os: [ubuntu-latest, windows-latest]');
    expect(scheduled).toContain(
      `timeout-minutes: ${CI_WORKFLOW_TIMEOUTS.fullMinutes}`
    );
    expect(scheduled.split('permissions:')[0]).not.toContain('matrix.');
    expect(scheduled).toContain('bun run ci:nightly');
    expect(scheduled).toContain('bun run ci:release');
    expect(scheduled).toContain('actions/upload-artifact@v4');
    expect(scheduled.match(/include-hidden-files: true/g)).toHaveLength(2);
    expect(scheduled).toContain('Install Linux traffic isolation tools');
    expect(scheduled).toContain('sudo apt-get install -y bubblewrap strace');
    expect(scheduled).toContain('Generate publication blockmaps');
    expect(scheduled).toContain(
      'OpenGameInstaller-Portable.zip updater/dist/OpenGameInstaller-Setup.exe'
    );
    expect(scheduled).toContain(
      'OpenGameInstaller-Setup.AppImage application/dist/OpenGameInstaller-linux-pt.AppImage'
    );
    expect(scheduled).toContain("-name '*.blockmap'");

    expect(release).toContain('e2e-release:');
    expect(release).toContain('needs: build');
    expect(release).toContain('name: windows-assets');
    expect(release).toContain('name: linux-assets');
    expect(release).toContain('Download exact publication assets');
    expect(release).toContain('Install Linux traffic isolation tools');
    expect(release).toContain('sudo apt-get install -y bubblewrap strace');
    expect(release).toContain("-name '*.blockmap'");
    expect(release).toContain('include-hidden-files: true');
    expect(release).toContain('bun run ci:release');
    expect(release).toContain('needs: [build, e2e-release]');
  });
});
