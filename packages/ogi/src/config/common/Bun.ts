import { spawn } from 'node:child_process';

// stopping ogi only signals ogi, so these get passed on to the script
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// runs bun with the terminal inherited so colours and progress bars survive
function bun(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', args, { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals): void => void proc.kill(signal);
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);

    proc.once('error', reject);
    proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      if (code === 0) resolve();
      else
        reject(
          new Error(`bun ${args.join(' ')} exited with ${code ?? signal}`)
        );
    });
  });
}

export const BunCommonCommands = {
  InstallDependencies: () => bun('install'),
  InstallFrozenDependencies: () => bun('install', '--frozen-lockfile'),
  // forwarded args go last so the script sees them in its own process.argv
  RunScript:
    (...args: string[]) =>
    (forwarded: string[] = []) =>
      bun(...args, ...forwarded),
} as const;
