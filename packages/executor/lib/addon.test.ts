import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { AddonError } from '@ogi-sdk/errors';
import { Effect, Fiber } from 'effect';
import { Addon } from './addon';

type AddonInternals = {
  spawnProcess: (
    command: string,
    args: string[]
  ) => Effect.Effect<ChildProcess, AddonError>;
  stopProcess: (child: ChildProcess) => Effect.Effect<void, AddonError>;
  monitorProcess: (child: ChildProcess) => Effect.Effect<void, AddonError>;
};

const makeAddon = (): Addon =>
  new Addon({
    name: 'test-addon',
    path: process.cwd(),
    port: 1234,
    secret: 'secret',
    scripts: { run: 'bun addon.ts' },
  });

const internals = (addon: Addon): AddonInternals =>
  addon as unknown as AddonInternals;

describe('Addon process lifecycle', () => {
  test('closes the standalone scope when start is interrupted', async () => {
    const addon = makeAddon();
    const child = {} as ChildProcess;
    let spawnStarted: () => void = () => undefined;
    let completeSpawn: () => void = () => undefined;
    let processStopped: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      spawnStarted = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      processStopped = resolve;
    });

    internals(addon).spawnProcess = () =>
      Effect.async<ChildProcess, AddonError>((resume) => {
        completeSpawn = () => resume(Effect.succeed(child));
        spawnStarted();
      });
    internals(addon).monitorProcess = () => Effect.never;
    internals(addon).stopProcess = () => Effect.sync(processStopped);

    const fiber = Effect.runFork(addon.start());
    await started;
    const interrupting = Effect.runPromise(Fiber.interrupt(fiber));
    await Bun.sleep(0);
    completeSpawn();
    await stopped;
    await interrupting;

    expect(addon.getChildProcess()).toBeNull();
  });

  test('retains scope ownership until stop', async () => {
    const addon = makeAddon();
    const child = {} as ChildProcess;
    let stopCount = 0;

    internals(addon).spawnProcess = () => Effect.succeed(child);
    internals(addon).monitorProcess = () => Effect.never;
    internals(addon).stopProcess = () =>
      Effect.sync(() => {
        stopCount += 1;
      });

    await Effect.runPromise(addon.start());
    expect(addon.getChildProcess()).toBe(child);

    await Effect.runPromise(addon.stop());
    expect(stopCount).toBe(1);
    expect(addon.getChildProcess()).toBeNull();
  });

  test('restarts by releasing the previous owned scope', async () => {
    const addon = makeAddon();
    const children = [{} as ChildProcess, {} as ChildProcess];
    let spawnCount = 0;
    let stopCount = 0;

    internals(addon).spawnProcess = () =>
      Effect.succeed(children[spawnCount++] as ChildProcess);
    internals(addon).monitorProcess = () => Effect.never;
    internals(addon).stopProcess = () =>
      Effect.sync(() => {
        stopCount += 1;
      });

    await Effect.runPromise(addon.start());
    await Effect.runPromise(addon.restart());

    expect(stopCount).toBe(1);
    expect(addon.getChildProcess()).toBe(children[1] as ChildProcess);

    await Effect.runPromise(addon.stop());
    expect(stopCount).toBe(2);
  });
});
