import { spawnSync } from 'node:child_process';
import { ACCESSIBILITY_STATES } from './accessibility-states.ts';

for (const state of ACCESSIBILITY_STATES) {
  const command = process.platform === 'linux' ? 'xvfb-run' : 'bunx';
  const args =
    process.platform === 'linux'
      ? ['-a', 'bunx', 'wdio', 'run', './wdio.conf.ts']
      : ['wdio', 'run', './wdio.conf.ts'];
  const result = spawnSync(command, args, {
    cwd: import.meta.dirname,
    env: { ...process.env, OGI_ACCESSIBILITY_STATE: state },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
