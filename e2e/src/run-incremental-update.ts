import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  INCREMENTAL_UPDATE_MODES,
  type IncrementalUpdateMode,
} from './packaged-handoff';

const runnerPath = join(import.meta.dir, 'run-reliable-packaged-handoff.ts');
const pinRequested = process.argv.slice(2).includes('--pin');
if (process.argv.slice(2).some((argument) => argument !== '--pin')) {
  throw new Error(
    'Incremental update accepts only the optional --pin argument'
  );
}

function runIncrementalCase(incrementalUpdate: IncrementalUpdateMode) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        runnerPath,
        ...(pinRequested ? ['--pin'] : []),
        `--incremental-update=${incrementalUpdate}`,
      ],
      { stdio: 'inherit' }
    );
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Incremental update case ${incrementalUpdate} exited with status ${status} and signal ${signal}`
        )
      );
    });
  });
}

for (const incrementalUpdate of INCREMENTAL_UPDATE_MODES) {
  if (incrementalUpdate === 'none') continue;
  console.log(`Running incremental update case: ${incrementalUpdate}`);
  await runIncrementalCase(incrementalUpdate);
}
