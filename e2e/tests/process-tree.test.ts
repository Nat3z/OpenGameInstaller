import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { Effect } from 'effect';
import {
  getProcessTreeStrategy,
  getWindowsTaskkillArgs,
  terminateProcessTree,
} from '../src/process-tree';

test('selects deterministic platform process-tree containment', () => {
  expect(getProcessTreeStrategy('win32')).toBe('windows-job-object');
  expect(getProcessTreeStrategy('linux')).toBe('posix-process-group');
});

test('targets the Windows Job Object wrapper and its tree', () => {
  expect(getWindowsTaskkillArgs([100, 101])).toEqual([
    '/PID',
    '100',
    '/PID',
    '101',
    '/T',
    '/F',
  ]);
});

test.skipIf(process.platform === 'win32')(
  'bounded teardown removes a complete POSIX process tree',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: 'ignore' }
    );
    expect(child.pid).toBeNumber();

    await Effect.runPromise(terminateProcessTree(child));
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }
);
