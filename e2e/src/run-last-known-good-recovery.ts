import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { RECOVERY_FAILURE_CASES } from './packaged-handoff';

const runnerPath = join(import.meta.dir, 'run-reliable-packaged-handoff.ts');
const pinRequested = process.argv.slice(2).includes('--pin');
if (process.argv.slice(2).some((argument) => argument !== '--pin')) {
  throw new Error(
    'Last Known-Good recovery accepts only the optional --pin argument'
  );
}

function runRecoveryCase(recoveryFailure: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        runnerPath,
        ...(pinRequested ? ['--pin'] : []),
        `--recovery-failure=${recoveryFailure}`,
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
          `Last Known-Good recovery case ${recoveryFailure} exited with status ${status} and signal ${signal}`
        )
      );
    });
  });
}

for (const recoveryFailure of RECOVERY_FAILURE_CASES) {
  console.log(`Running Last Known-Good recovery case: ${recoveryFailure}`);
  await runRecoveryCase(recoveryFailure);
}
