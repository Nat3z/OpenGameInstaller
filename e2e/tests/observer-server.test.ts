import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
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

function websocketUpgradeStatus(options: {
  port: number;
  cookie: string;
  origin?: string;
}) {
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection(options.port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      const headers = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${options.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        `Cookie: ${options.cookie}`,
        ...(options.origin === undefined ? [] : [`Origin: ${options.origin}`]),
        '',
        '',
      ];
      socket.write(headers.join('\r\n'));
    });
    socket.once('data', (data) => {
      const status = Number(data.toString().match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      socket.destroy();
      resolve(status);
    });
  });
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
    const stateResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/state`,
      { headers: { cookie: cookie! } }
    );
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as {
      selectedSuite: string;
      catalog: Array<{ id: string; type: string }>;
    };
    expect(state.selectedSuite).toBe('check:application-smoke');
    expect(
      state.catalog
        .filter((entry) => entry.type === 'preset')
        .map((entry) => entry.id)
    ).toEqual(['preset:pull-request', 'preset:nightly', 'preset:release']);
  });

  test('requires the exact Observer Origin for WebSocket refresh and reconnect', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
    });
    servers.push(server);
    const bootstrap = await fetch(server.url);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeDefined();
    const port = server.port;
    if (port === undefined) throw new Error('Observer port was not allocated');
    const allowedOrigin = `http://127.0.0.1:${port}`;

    for (const origin of [
      undefined,
      'null',
      `http://127.0.0.1:${port + 1}`,
      `http://localhost:${port}`,
      `https://127.0.0.1:${port}`,
    ]) {
      expect(
        await websocketUpgradeStatus({
          port,
          cookie: cookie!,
          ...(origin === undefined ? {} : { origin }),
        })
      ).toBe(403);
    }
    expect(
      await websocketUpgradeStatus({
        port,
        cookie: cookie!,
        origin: allowedOrigin,
      })
    ).toBe(101);
    expect(
      await websocketUpgradeStatus({
        port,
        cookie: cookie!,
        origin: allowedOrigin,
      })
    ).toBe(101);
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

  test('validates and forwards deterministic catalog selections', async () => {
    const selection = 'preset:nightly';
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'assert-selection',
        selection,
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    expect(() =>
      server.command({ type: 'start', suite: 'check:not-real' })
    ).toThrow('Unknown deterministic suite');
    server.command({ type: 'start', suite: selection });
    await waitUntil(
      () =>
        server.getState().status === 'Passed' &&
        !server.getState().processActive,
      'Observer did not forward the deterministic selection'
    );
    expect(server.getState().selectedSuite).toBe(selection);
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

    server.command({ type: 'start', suite: 'check:application-smoke' });
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
    server.command({ type: 'start', suite: 'check:application-smoke' });
    await waitUntil(
      () => server.getState().status === 'Running',
      'Run did not start'
    );
    await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { cookie: cookie! },
    });
    await waitUntil(
      () =>
        server.getState().status === 'Passed' &&
        !server.getState().processActive,
      'Run did not continue after dashboard refresh'
    );
    expect(server.getState()).toMatchObject({
      status: 'Passed',
      outcome: 'Passed',
      processActive: false,
    });
  });

  test('keeps the completed Observer state after a passed sandbox is deleted', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'complete-delete',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    server.command({ type: 'start', suite: 'check:application-smoke' });
    await waitUntil(
      () =>
        server.getState().status === 'Passed' &&
        !server.getState().processActive,
      'Observer lost the passed result after sandbox deletion'
    );
    expect(server.getState()).toMatchObject({
      status: 'Passed',
      outcome: 'Passed',
      totals: { Passed: 1 },
    });
  });

  test('keeps Observer artifacts available until the session closes', async () => {
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      runnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'complete-retained-artifact',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);
    const bootstrap = await fetch(server.url);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];

    server.command({ type: 'start', suite: 'check:application-smoke' });
    await waitUntil(
      () =>
        server.getState().status === 'Passed' &&
        !server.getState().processActive,
      'Observer artifact run did not complete'
    );
    const artifact = await fetch(
      `http://127.0.0.1:${server.port}/artifact?path=${encodeURIComponent('artifacts/navigate-discovery.png')}`,
      { headers: { cookie: cookie! } }
    );
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe('observer artifact');
    await waitUntil(
      () =>
        server
          .getState()
          .output.some((line) => line.startsWith('Scenario Sandbox: ')),
      'Observer did not capture the retained sandbox path'
    );
    const sandboxDirectory = server
      .getState()
      .output.join('\n')
      .match(/Scenario Sandbox: (.+)/)?.[1]
      ?.trim();
    expect(sandboxDirectory).toBeTruthy();
    expect(existsSync(sandboxDirectory!)).toBe(true);

    servers.splice(servers.indexOf(server), 1);
    await server.close();
    expect(existsSync(sandboxDirectory!)).toBe(false);
  });

  test('keeps Live Service selection separate, confirmed, credentialed, and redacted', async () => {
    const secret = 'synthetic/observer secret+XYZ';
    const server = await createObserverServer({
      distDirectory: createDist(),
      openWindow: false,
      liveServiceRunnerCommand: [
        process.execPath,
        join(import.meta.dir, 'fixtures/observer-runner.ts'),
        'live',
      ],
      pollIntervalMilliseconds: 20,
    });
    servers.push(server);

    expect(() =>
      server.command({
        type: 'start-live-service',
        provider: 'synthetic-local',
        confirmed: false,
        credential: secret,
      })
    ).toThrow('confirmation');
    expect(() =>
      server.command({
        type: 'start-live-service',
        provider: 'synthetic-local',
        confirmed: true,
        credential: '',
      })
    ).toThrow('credential');

    server.command({
      type: 'start-live-service',
      provider: 'synthetic-local',
      confirmed: true,
      credential: secret,
    });
    await waitUntil(
      () =>
        server.getState().status === 'Passed' &&
        !server.getState().processActive,
      'Live Service run did not complete'
    );
    expect(server.getState().scenarios[0]?.kind).toBe('Live Service Scenario');
    expect(server.getState().externalIntegrationHealth).toEqual({
      provider: 'synthetic-local',
      status: 'Healthy',
      deterministicCoverage: 'Not evaluated',
      responseStatus: 200,
    });
    const output = server.getState().output.join('\n');
    let percentToken = 0;
    const mixedPercent = encodeURIComponent(secret).replace(
      /%[0-9A-F]{2}/g,
      (value) => {
        percentToken += 1;
        return percentToken % 2 === 0
          ? value.toLowerCase()
          : value.toUpperCase();
      }
    );
    for (const variant of [
      secret,
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      new URLSearchParams({ token: secret }).toString().slice('token='.length),
      mixedPercent,
      encodeURIComponent(mixedPercent),
    ]) {
      expect(output).not.toContain(variant);
    }
    expect(output).toContain('[REDACTED]');
  });

  test('scrubs inherited Live Service credentials from deterministic Observer runs', async () => {
    const prior = process.env.OGI_LIVE_GITHUB_TOKEN;
    process.env.OGI_LIVE_GITHUB_TOKEN = 'must-not-inherit';
    try {
      const server = await createObserverServer({
        distDirectory: createDist(),
        openWindow: false,
        runnerCommand: [
          process.execPath,
          join(import.meta.dir, 'fixtures/observer-runner.ts'),
          'assert-no-live-env',
        ],
        pollIntervalMilliseconds: 20,
      });
      servers.push(server);
      server.command({ type: 'start', suite: 'check:application-smoke' });
      await waitUntil(
        () =>
          server.getState().status === 'Passed' &&
          !server.getState().processActive,
        'Deterministic Observer run did not complete'
      );
    } finally {
      if (prior === undefined) delete process.env.OGI_LIVE_GITHUB_TOKEN;
      else process.env.OGI_LIVE_GITHUB_TOKEN = prior;
    }
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

    server.command({ type: 'start', suite: 'check:application-smoke' });
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
