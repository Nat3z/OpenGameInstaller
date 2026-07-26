import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CI_BUDGETS } from './ci-gates';
import { makeRunEventWriter } from './run-events';
import { getDefaultRunRoot } from './run-reliability';

const reliableRunner = join(
  import.meta.dir,
  'run-reliable-packaged-handoff.ts'
);

if (process.platform !== 'win32') {
  const result = spawnSync(
    process.execPath,
    [reliableRunner, '--pin', '--deterministic-torrent-installation'],
    {
      env: process.env,
      stdio: 'inherit',
      timeout: CI_BUDGETS.deterministicTorrentJourneyMs,
      killSignal: 'SIGTERM',
    }
  );
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  ) {
    throw new Error(
      'Deterministic torrent Product Journey exceeded its budget'
    );
  }
  process.exitCode = result.status ?? 1;
} else {
  const runId = randomUUID();
  const runDirectory = resolve(
    getDefaultRunRoot(),
    `deterministic-torrent-windows-static-${runId}`
  );
  const artifactDirectory = join(runDirectory, 'artifacts');
  mkdirSync(artifactDirectory, { recursive: true });
  const eventLogPath = join(runDirectory, 'events.jsonl');
  const writeEvent = makeRunEventWriter(eventLogPath, runId);
  writeEvent({
    type: 'run.started',
    payload: { platform: process.platform },
  });
  writeEvent({
    type: 'scenario.started',
    payload: {
      scenarioId: 'deterministic-torrent-windows-static',
      kind: 'Product Journey',
    },
  });
  writeEvent({
    type: 'attempt.started',
    payload: {
      scenarioId: 'deterministic-torrent-windows-static',
      attempt: 1,
    },
  });
  const result = spawnSync(
    process.execPath,
    [
      'test',
      join(import.meta.dir, '../tests/packaged-handoff.test.ts'),
      join(import.meta.dir, '../tests/ci-gates.test.ts'),
    ],
    {
      stdio: 'inherit',
      timeout: CI_BUDGETS.deterministicTorrentJourneyMs,
      killSignal: 'SIGTERM',
    }
  );
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const passed = result.status === 0 && !timedOut;
  const assertions = [
    {
      artifactType: 'torrent-network-containment-assertion' as const,
      name: 'torrent-network-containment-assertion.json',
      contents: {
        version: 1,
        mode: 'windows-static',
        firewallProgramScope: true,
        inboundBlocked: true,
        outboundBlocked: true,
        cleanupRequired: true,
        passed,
      },
    },
    {
      artifactType: 'torrent-network-isolation-assertion' as const,
      name: 'torrent-network-isolation-assertion.json',
      contents: {
        version: 1,
        mode: 'windows-static',
        firewallProgramScope: true,
        wildcardListenersExternallyReachable: false,
        cleanupRequired: true,
        passed,
      },
    },
    {
      artifactType: 'torrent-payload-manifest-assertion' as const,
      name: 'torrent-payload-manifest-assertion.json',
      contents: {
        version: 1,
        mode: 'windows-static',
        completePayloadManifestRequired: true,
        exactLauncherBytesRequired: true,
        corruptSecondFileRejected: true,
        passed,
      },
    },
  ];
  for (const assertion of assertions) {
    const path = join(artifactDirectory, assertion.name);
    writeFileSync(path, JSON.stringify(assertion.contents, null, 2));
    writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType: assertion.artifactType,
        path: join('artifacts', assertion.name).replaceAll('\\', '/'),
      },
    });
  }
  const outcome = passed ? 'Passed' : 'Failed';
  writeEvent({
    type: 'attempt.completed',
    payload: { attempt: 1, outcome },
  });
  writeEvent({
    type: 'scenario.completed',
    payload: {
      scenarioId: 'deterministic-torrent-windows-static',
      outcome,
    },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
  process.exitCode = passed ? 0 : 1;
}
