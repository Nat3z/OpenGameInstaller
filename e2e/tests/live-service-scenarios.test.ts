import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_SUITES } from '../src/ci-gates';
import {
  createSecretRedactor,
  executeLiveServiceScenario,
  generateSecretVariants,
  prepareLiveServiceEnvironment,
  resolveLiveServiceRequest,
} from '../src/live-service-scenarios';
import { readRunEvents } from '../src/run-events';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

async function cancellableProvider() {
  let releaseResponse: (() => void) | undefined;
  let markRequested: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const server = createServer((_request, response) => {
    markRequested?.();
    releaseResponse = () => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true }));
    };
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    endpoint: `http://127.0.0.1:${address.port}/health`,
    requested,
    release: () => releaseResponse?.(),
  };
}

async function localProvider(secret: string, includeSecretInUrl = false) {
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${secret}`;
    response.writeHead(authorized ? 200 : 401, {
      'content-type': 'application/json',
      'x-synthetic-secret': secret,
    });
    const mixedPercent = mixedCasePercentEncoding(secret);
    response.end(
      JSON.stringify({
        healthy: authorized,
        echoedAuthorization: request.headers.authorization,
        credentialInUrl: `${request.headers.host}/health?token=${secret}`,
        mixedPercent,
        doubleEncodedPercent: encodeURIComponent(mixedPercent),
        malformedWrappedPercent: `%ZZ${mixedPercent}%Q`,
      })
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}/health${
    includeSecretInUrl ? `?probe=${encodeURIComponent(secret)}` : ''
  }`;
}

async function redirectProvider(secret: string) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.searchParams.get('hop') === '0') {
      response.writeHead(302, {
        location: `/health?hop=1&token=${Buffer.from(secret).toString('base64url')}`,
      });
      response.end();
      return;
    }
    if (url.searchParams.get('hop') === '1') {
      response.writeHead(307, { location: '/health?hop=2' });
      response.end();
      return;
    }
    const redirect = url.searchParams.get('redirect');
    if (redirect) {
      response.writeHead(302, { location: redirect });
      response.end();
      return;
    }
    if (url.searchParams.get('loop') === '1') {
      response.writeHead(302, { location: '/health?loop=1' });
      response.end();
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${secret}`;
    response.writeHead(authorized ? 200 : 401, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ healthy: authorized }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    endpoint: `http://127.0.0.1:${address.port}/health`,
  };
}

async function exfiltrationEndpoint() {
  let requests = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    requests += 1;
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    endpoint: `http://127.0.0.1:${address.port}/steal`,
    requests: () => requests,
    authorization: () => authorization,
  };
}

function mixedCasePercentEncoding(secret: string) {
  let token = 0;
  return encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (value) => {
    token += 1;
    return token % 2 === 0 ? value.toLowerCase() : value.toUpperCase();
  });
}

function independentlyDetectCanonicalPercentLeak(
  input: string,
  secrets: readonly string[]
) {
  const decodedCandidates = new Set<string>();
  for (const formEncoded of [false, true]) {
    let current = formEncoded ? input.replaceAll('+', ' ') : input;
    decodedCandidates.add(current);
    for (let round = 0; round < 3; round += 1) {
      const next = current.replace(/(?:%[0-9a-f]{2})+/gi, (sequence) => {
        try {
          return decodeURIComponent(sequence);
        } catch {
          return sequence;
        }
      });
      decodedCandidates.add(next);
      if (next === current) break;
      current = next;
    }
  }
  return secrets.some((secret) =>
    [...decodedCandidates].some((candidate) =>
      (['NFC', 'NFD', 'NFKC', 'NFKD'] as const).some((normalization) =>
        candidate
          .normalize(normalization)
          .includes(secret.normalize(normalization))
      )
    )
  );
}

function allFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

describe('Live Service Scenarios', () => {
  test('requires separate selection, explicit confirmation, and credentials', () => {
    expect(() =>
      resolveLiveServiceRequest({
        provider: 'github',
        confirmed: false,
        environment: {},
      })
    ).toThrow('explicit confirmation');
    expect(() =>
      resolveLiveServiceRequest({
        provider: 'github',
        confirmed: true,
        environment: {},
      })
    ).toThrow('OGI_LIVE_GITHUB_TOKEN');
    expect(() =>
      resolveLiveServiceRequest({
        provider: 'application-smoke',
        confirmed: true,
        environment: { OGI_LIVE_GITHUB_TOKEN: 'synthetic-secret' },
      })
    ).toThrow('Unknown Live Service provider');
  });

  test('never inherits live credentials into deterministic or shared CI environments', () => {
    const prepared = prepareLiveServiceEnvironment(
      {
        PATH: '/bin',
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        OGI_LIVE_GITHUB_TOKEN: 'synthetic-secret',
        OGI_LIVE_SERVICE_CREDENTIAL: 'another-secret',
      },
      undefined
    );
    expect(prepared).toEqual({
      PATH: '/bin',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
    });
    for (const suite of Object.values(CI_SUITES)) {
      expect(suite.some((entry) => entry.id.includes('live-service'))).toBe(
        false
      );
    }
    for (const environment of [
      { CI: 'true' },
      { CI: '1' },
      { CI: 'TRUE' },
      { GITHUB_ACTIONS: '1' },
      { GITLAB_CI: 'yes' },
      { BUILDKITE: 'on' },
    ]) {
      expect(() =>
        resolveLiveServiceRequest({
          provider: 'github',
          confirmed: true,
          environment: {
            ...environment,
            OGI_LIVE_GITHUB_TOKEN: 'synthetic-secret',
          },
        })
      ).toThrow('shared CI');
    }
    expect(() =>
      resolveLiveServiceRequest({
        provider: 'github',
        confirmed: true,
        environment: {
          CI: 'false',
          OGI_LIVE_GITHUB_TOKEN: 'synthetic-secret',
        },
      })
    ).not.toThrow();
  });

  test('exported API rejects real-provider endpoint overrides before credentials can leave', async () => {
    const exfiltration = await exfiltrationEndpoint();
    const credential = 'synthetic-github-exfiltration-secret';
    await expect(
      // @ts-expect-error Real providers have immutable registered endpoints.
      executeLiveServiceScenario({
        provider: 'github',
        confirmed: true,
        credential,
        environment: { CI: 'false' },
        endpoint: exfiltration.endpoint,
      })
    ).rejects.toThrow('endpoint override');
    expect(exfiltration.requests()).toBe(0);
    expect(exfiltration.authorization()).toBeUndefined();
  });

  test('real-provider redirects are manually rejected against the immutable registry', async () => {
    const credential = 'synthetic-github-redirect-secret';
    const calls: Array<{
      url: string;
      authorization?: string;
      method?: string;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('authorization') ?? undefined,
        method: init?.method,
      });
      return new Response('', {
        status: 302,
        headers: { location: 'https://uploads.github.com/exfiltrate' },
      });
    }) as typeof fetch;
    try {
      const result = await executeLiveServiceScenario({
        provider: 'github',
        confirmed: true,
        credential,
        environment: { CI: 'false' },
        runRoot: mkdtempSync(
          join(tmpdir(), 'ogi-live-service-github-redirect-')
        ),
      });
      expect(result.outcome).toBe('Failed');
      expect(calls).toEqual([
        {
          url: 'https://api.github.com/user',
          authorization: `Bearer ${credential}`,
          method: 'GET',
        },
      ]);
      expect(
        readFileSync(
          join(result.sandboxDirectory, 'artifacts/live-service-provider.log'),
          'utf8'
        )
      ).toContain('registered redirect allowlist');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('hard-refuses direct real-provider execution under active CI markers', async () => {
    await expect(
      executeLiveServiceScenario({
        provider: 'github',
        confirmed: true,
        credential: 'synthetic-secret',
        environment: { CI: '1' },
      })
    ).rejects.toThrow('shared CI');
  });

  test('redacts normalized, URL, form, Base64, Base64URL, hex, and header secret variants', () => {
    const secret = 'synthetic/Secrét Value+XYZ9';
    const normalized = secret.normalize('NFC');
    const percentEncoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ token: secret })
      .toString()
      .slice('token='.length);
    const base64 = Buffer.from(secret).toString('base64');
    const base64Url = Buffer.from(secret).toString('base64url');
    const variants = [
      secret,
      normalized,
      percentEncoded,
      percentEncoded.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()),
      formEncoded,
      base64,
      base64.replace(/=+$/, ''),
      base64Url,
      `${base64Url}==`,
      Buffer.from(secret).toString('hex'),
      Buffer.from(secret).toString('hex').toUpperCase(),
    ];
    const redact = createSecretRedactor([secret]);
    for (const variant of variants) {
      expect(redact.text(`prefix ${variant} suffix`)).not.toContain(variant);
    }
    for (const header of [
      `Authorization: Bearer ${secret}`,
      `Authorization: Basic ${base64}`,
      `X-Api-Key: ${secret}`,
      `Cookie: session=${secret}`,
    ]) {
      expect(redact.text(header)).toContain('[REDACTED]');
      expect(redact.text(header)).not.toContain(secret);
    }
    expect(JSON.stringify(redact.value({ nested: [secret] }))).not.toContain(
      secret
    );
    expect(redact.artifactName(`failure-${secret}.png`)).toBe(
      'failure-REDACTED.png'
    );
    expect(createSecretRedactor(['a']).text('catalog')).toBe('catalog');
  });

  test('redacts mixed-case, double-encoded, and malformed-wrapped percent encodings canonically', () => {
    const secret = 'synthetic/Percent Secret+é/XYZ9';
    const mixed = mixedCasePercentEncoding(secret);
    const adversarialCorpus = [
      mixed,
      encodeURIComponent(mixed),
      `%ZZ${mixed}%Q`,
      `prefix=${mixed}&broken=%`,
    ];
    const redact = createSecretRedactor([secret]);
    for (const adversarial of adversarialCorpus) {
      const redacted = redact.text(`evidence ${adversarial}`);
      expect(redacted).not.toContain(adversarial);
      expect(independentlyDetectCanonicalPercentLeak(redacted, [secret])).toBe(
        false
      );
    }
    const caseChangedRawData = mixed.replace('synthetic', 'SYNTHETIC');
    expect(redact.text(caseChangedRawData)).toBe(caseChangedRawData);
  });

  test('CLI rejects provider selection and confirmation supplied only through environment variables', async () => {
    const secret = 'synthetic-cli-explicit-secret';
    const endpoint = await localProvider(secret);
    const baseEnvironment = {
      ...process.env,
      OGI_LIVE_SERVICE_PROVIDER: 'synthetic-local',
      OGI_LIVE_SERVICE_CONFIRMED: '1',
      OGI_LIVE_SERVICE_CREDENTIAL: secret,
      OGI_LIVE_SERVICE_ALLOW_SYNTHETIC: '1',
      OGI_LIVE_SERVICE_ENDPOINT: endpoint,
    };
    const withoutProvider = Bun.spawn(
      [process.execPath, 'run', 'src/run-live-service-scenario.ts'],
      {
        cwd: join(import.meta.dir, '..'),
        env: baseEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [providerStatus, providerError] = await Promise.all([
      withoutProvider.exited,
      new Response(withoutProvider.stderr).text(),
    ]);
    expect(providerStatus).not.toBe(0);
    expect(providerError).toContain('explicit --provider');

    const withoutConfirmation = Bun.spawn(
      [
        process.execPath,
        'run',
        'src/run-live-service-scenario.ts',
        '--provider',
        'synthetic-local',
        '--endpoint',
        endpoint,
      ],
      {
        cwd: join(import.meta.dir, '..'),
        env: baseEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [confirmationStatus, confirmationError] = await Promise.all([
      withoutConfirmation.exited,
      new Response(withoutConfirmation.stderr).text(),
    ]);
    expect(confirmationStatus).not.toBe(0);
    expect(confirmationError).toContain('explicit confirmation');
  });

  test('CLI runs only after explicit selection and confirmation without printing credentials', async () => {
    const secret = 'synthetic-cli-secret-XYZ789';
    const endpoint = await localProvider(secret);
    const runRoot = mkdtempSync(join(tmpdir(), 'ogi-live-service-cli-'));
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        'src/run-live-service-scenario.ts',
        '--provider',
        'synthetic-local',
        '--confirm-live-service',
        '--endpoint',
        endpoint,
      ],
      {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          OGI_LIVE_SYNTHETIC_TOKEN: secret,
          OGI_LIVE_SERVICE_ALLOW_SYNTHETIC: '1',
          OGI_E2E_RUN_ROOT: runRoot,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(`${stdout}\n${stderr}`).not.toContain(secret);
    expect(stdout).toContain('external integration health');
    expect(stdout).toContain('Deterministic coverage: not evaluated');
    expect(readdirSync(runRoot)).toHaveLength(1);
  });

  test('CLI honors the Observer cancellation control file without SIGTERM fallback', async () => {
    const secret = 'synthetic-cli-cancellation-secret';
    const provider = await cancellableProvider();
    const controlDirectory = mkdtempSync(
      join(tmpdir(), 'ogi-live-service-cli-cancel-control-')
    );
    const cancellationPath = join(controlDirectory, 'cancel');
    const announcementPath = join(controlDirectory, 'announcement.json');
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        'src/run-live-service-scenario.ts',
        '--provider',
        'synthetic-local',
        '--confirm-live-service',
        '--endpoint',
        provider.endpoint,
      ],
      {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          OGI_LIVE_SYNTHETIC_TOKEN: secret,
          OGI_LIVE_SERVICE_ALLOW_SYNTHETIC: '1',
          OGI_OBSERVER_ANNOUNCEMENT: announcementPath,
          OGI_OBSERVER_CANCELLATION: cancellationPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    await provider.requested;
    writeFileSync(cancellationPath, new Date().toISOString());
    const status = await Promise.race([
      child.exited,
      Bun.sleep(1_000).then(() => null),
    ]);
    if (status === null) child.kill('SIGKILL');
    provider.release();
    expect(status).toBe(1);
    const announcement = JSON.parse(readFileSync(announcementPath, 'utf8')) as {
      eventLogPath: string;
    };
    expect(
      readRunEvents(announcement.eventLogPath).find(
        (event) => event.type === 'run.completed'
      )?.payload.outcome
    ).toBe('Cancelled');
  });

  test('follows only a bounded same-origin same-path synthetic redirect chain', async () => {
    const secret = 'synthetic-redirect-secret';
    const provider = await redirectProvider(secret);
    const result = await executeLiveServiceScenario({
      provider: 'synthetic-local',
      confirmed: true,
      credential: secret,
      endpoint: `${provider.endpoint}?hop=0`,
      runRoot: mkdtempSync(join(tmpdir(), 'ogi-live-service-redirect-run-')),
    });
    expect(result.outcome).toBe('Passed');
    const log = readFileSync(
      join(result.sandboxDirectory, 'artifacts/live-service-provider.log'),
      'utf8'
    );
    expect(log).toContain('"redirects"');
    expect(log).toContain('"status": 302');
    expect(log).toContain('"status": 307');
    expect(log).not.toContain(Buffer.from(secret).toString('base64url'));
  });

  test('rejects ambiguous, credentialed, cross-origin, cross-path, and looping redirects', async () => {
    const secret = 'synthetic-invalid-redirect-secret';
    const provider = await redirectProvider(secret);
    const targets = [
      `//127.0.0.1:${new URL(provider.origin).port}/health`,
      `http://localhost:${new URL(provider.origin).port}/health`,
      `http://0.0.0.0:${new URL(provider.origin).port}/health`,
      'http://192.168.1.2/health',
      'http://example.com/health',
      'http://user:password@127.0.0.1/health',
      'http://127.0.0.1:1/health',
      `${provider.origin}/other`,
    ];
    for (const target of targets) {
      const result = await executeLiveServiceScenario({
        provider: 'synthetic-local',
        confirmed: true,
        credential: secret,
        endpoint: `${provider.endpoint}?redirect=${encodeURIComponent(target)}`,
        runRoot: mkdtempSync(join(tmpdir(), 'ogi-live-service-bad-redirect-')),
      });
      expect(result.outcome).toBe('Failed');
      const log = readFileSync(
        join(result.sandboxDirectory, 'artifacts/live-service-provider.log'),
        'utf8'
      );
      expect(log).not.toContain('"status": 200');
      expect(log).toContain('"to": "[rejected]"');
      expect(log).not.toContain('user:password');
    }
    const loop = await executeLiveServiceScenario({
      provider: 'synthetic-local',
      confirmed: true,
      credential: secret,
      endpoint: `${provider.endpoint}?loop=1`,
      runRoot: mkdtempSync(join(tmpdir(), 'ogi-live-service-loop-')),
    });
    expect(loop.outcome).toBe('Failed');
    expect(
      readFileSync(
        join(loop.sandboxDirectory, 'artifacts/live-service-provider.log'),
        'utf8'
      )
    ).toContain('redirect loop');
  });

  test('cancels an active provider request and finalizes typed retained evidence', async () => {
    const secret = 'synthetic-cancellation-secret';
    const provider = await cancellableProvider();
    const controlDirectory = mkdtempSync(
      join(tmpdir(), 'ogi-live-service-cancel-control-')
    );
    const cancellationPath = join(controlDirectory, 'cancel');
    const runRoot = mkdtempSync(join(tmpdir(), 'ogi-live-service-cancel-run-'));
    const execution = executeLiveServiceScenario({
      provider: 'synthetic-local',
      confirmed: true,
      credential: secret,
      endpoint: provider.endpoint,
      runRoot,
      cancellationPath,
    });
    await provider.requested;
    writeFileSync(cancellationPath, new Date().toISOString());
    const promptResult = await Promise.race([
      execution,
      Bun.sleep(500).then(() => null),
    ]);
    provider.release();
    const result = promptResult ?? (await execution);

    expect(promptResult).not.toBeNull();
    expect(result.outcome).toBe('Cancelled');
    const events = readRunEvents(result.eventLogPath);
    expect(
      events.find((event) => event.type === 'step.completed')?.payload.outcome
    ).toBe('Cancelled');
    expect(
      events.find((event) => event.type === 'attempt.completed')?.payload
        .outcome
    ).toBe('Cancelled');
    expect(
      events.find((event) => event.type === 'scenario.completed')?.payload
        .outcome
    ).toBe('Cancelled');
    expect(
      events.find((event) => event.type === 'run.completed')?.payload.outcome
    ).toBe('Cancelled');
    expect(existsSync(join(result.sandboxDirectory, 'report.html'))).toBe(true);
    expect(existsSync(join(result.sandboxDirectory, 'summary.json'))).toBe(
      true
    );
    expect(existsSync(join(result.sandboxDirectory, 'retention.json'))).toBe(
      true
    );
  });

  test('reports external health and retains only redacted evidence with a synthetic local provider', async () => {
    const secret = 'synthetic/live secret+ABC123';
    const endpoint = await localProvider(secret, true);
    const runRoot = mkdtempSync(join(tmpdir(), 'ogi-live-service-test-'));
    const result = await executeLiveServiceScenario({
      provider: 'synthetic-local',
      confirmed: true,
      credential: secret,
      endpoint,
      runRoot,
    });

    expect(result.outcome).toBe('Passed');
    expect(result.externalIntegrationHealth).toEqual({
      provider: 'synthetic-local',
      status: 'Healthy',
      deterministicCoverage: 'Not evaluated',
    });
    expect(existsSync(result.sandboxDirectory)).toBe(true);
    const events = readRunEvents(result.eventLogPath);
    expect(
      events.some((event) => event.type === 'external-integration.health')
    ).toBe(true);
    expect(
      events.find((event) => event.type === 'scenario.started')?.payload.kind
    ).toBe('Live Service Scenario');

    const files = allFiles(result.sandboxDirectory);
    expect(files.some((path) => path.endsWith('live-service-status.png'))).toBe(
      true
    );
    const variants = generateSecretVariants([secret]);
    for (const path of files) {
      const bytes = readFileSync(path);
      for (const variant of variants) {
        expect(path).not.toContain(variant);
        expect(bytes.includes(Buffer.from(variant))).toBe(false);
      }
      expect(
        independentlyDetectCanonicalPercentLeak(bytes.toString('utf8'), [
          secret,
        ])
      ).toBe(false);
    }
  });
});
