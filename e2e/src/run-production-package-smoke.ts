import { join, resolve } from 'node:path';
import { runProductionPackageSmoke } from './production-package-smoke';

const artifactDirectory = resolve(
  process.env.OGI_RELEASE_ARTIFACT_DIRECTORY ??
    join(process.cwd(), '.release-artifacts')
);
const runRoot = resolve(
  process.env.OGI_E2E_RUN_ROOT ?? join(process.cwd(), '.e2e-ci-runs')
);
const report = await runProductionPackageSmoke(
  artifactDirectory,
  join(runRoot, 'production-package-smoke')
);
console.log(JSON.stringify(report, null, 2));
