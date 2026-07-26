import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadQuarantineRegistry,
  runQuarantinedScenarioMatrix,
} from './quarantined-scenarios';

const runRoot = resolve(
  process.env.OGI_E2E_RUN_ROOT ?? join(process.cwd(), '.e2e-ci-runs')
);
const outputDirectory = join(runRoot, 'quarantined-scenarios');
mkdirSync(outputDirectory, { recursive: true });
const registryPath = resolve(
  process.env.OGI_E2E_QUARANTINE_REGISTRY ??
    join(import.meta.dir, '../quarantines.json')
);
const registrations = loadQuarantineRegistry(registryPath);
const execution = await runQuarantinedScenarioMatrix(
  registrations,
  outputDirectory
);
const report = {
  ...execution,
  registryPath,
  outcome:
    execution.discovered === 0
      ? ('No Quarantines' as const)
      : execution.outcome,
};
writeFileSync(
  join(outputDirectory, 'quarantine-report.json'),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log(JSON.stringify(report, null, 2));
if (execution.outcome === 'Failed') process.exitCode = 1;
