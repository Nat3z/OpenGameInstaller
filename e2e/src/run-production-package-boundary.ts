import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProductionPackagingBoundary } from './packaged-handoff';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(currentDirectory, '../..');
const report = verifyProductionPackagingBoundary(repositoryDirectory);
if (report.activeHookMatches.length > 0) {
  throw new Error(
    `Production packaging contains active E2E hooks: ${report.activeHookMatches.join(', ')}`
  );
}
console.log(JSON.stringify(report, null, 2));
