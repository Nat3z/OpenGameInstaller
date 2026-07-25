import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserverServer } from '../src/observer-server';

const servers: Array<Awaited<ReturnType<typeof createObserverServer>>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createDist() {
  const directory = mkdtempSync(join(tmpdir(), 'ogi-observer-dist-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><title>Observer</title>'
  );
  writeFileSync(join(directory, 'assets/app.js'), 'console.log("observer")');
  return directory;
}

async function waitUntil(
  condition: () => boolean,
  detail: string,
  timeoutMilliseconds = 5_000
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(detail);
    await Bun.sleep(25);
  }
}

describe('Observer Window server', () => {
  test('requires a one-time token and keeps authenticated refresh available', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
    });
    servers.push(server);

    expect(server.hostname).toBe('127.0.0.1');
    const bootstrap = await fetch(server.url);
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toContain('ogi-observer-session=');
    expect((await fetch(server.url)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${server.port}/`, {
          headers: { cookie: cookie! },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${server.port}/api/state`, {
          headers: { cookie: cookie! },
        })
      ).status
    ).toBe(200);
  });

  test('rejects non-loopback binding', async () => {
    await expect(
      createObserverServer({ hostname: '0.0.0.0', openWindow: false })
    ).rejects.toThrow('loopback');
  });

  test('places its own window beside the product without owning runner lifetime', () => {
    const windowMain = readFileSync(
      join(import.meta.dir, '../src/observer-window-main.cjs'),
      'utf8'
    );
    expect(windowMain).toContain('workArea.width / 2');
    expect(windowMain).toContain("window.on('closed', () => app.quit())");
    expect(windowMain).not.toContain('kill(');
  });

  test('Stop records Cancelled and waits for process-tree cleanup', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'wait',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    server.command({ type: 'start', suite: 'application-smoke' });
    await waitUntil(
      () => server.getState().lastSequence >= 4,
      'Observer did not follow the active Run Event Log'
    );
    server.command({ type: 'stop' });
    await waitUntil(
      () =>
        server.getState().status === 'Cancelled' &&
        !server.getState().processActive,
      'Stopped run did not finish as Cancelled'
    );
    expect(server.getState()).toMatchObject({
      status: 'Cancelled',
      outcome: 'Cancelled',
      processActive: false,
      totals: { Cancelled: 1 },
    });
  });

  test('run lifetime is independent of dashboard connections and refresh', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'complete',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    const bootstrap = await fetch(server.url);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    server.command({ type: 'start', suite: 'application-smoke' });
    await waitUntil(
      () => server.getState().status === 'Running',
      'Run did not start'
    );
    await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie: cookie! },
    });
    await waitUntil(
      () => server.getState().status === 'Passed',
      'Run did not continue after dashboard refresh'
    );
    expect(server.getState()).toMatchObject({
      status: 'Passed',
      outcome: 'Passed',
      processActive: false,
    });
  });

  test('rerun-failed starts a new attempt only after a failure outcome', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'fail',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    server.command({ type: 'start', suite: 'application-smoke' });
    await waitUntil(
      () =>
        server.getState().status === 'Failed' &&
        !server.getState().processActive,
      'Initial failure did not complete'
    );
    const firstRunId = server.getState().runId;
    expect(server.getState().canRerun).toBe(true);
    server.command({ type: 'rerun-failed' });
    await waitUntil(
      () =>
        server.getState().runId !== null &&
        server.getState().runId !== firstRunId,
      'Rerun did not start a new run'
    );
    await waitUntil(
      () =>
        server.getState().status === 'Failed' &&
        !server.getState().processActive,
      'Rerun failure did not complete'
    );
    expect(server.getState().runId).not.toBe(firstRunId);
  });
});
