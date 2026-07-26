import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  makeRunEventWriter,
  readRunEvents,
  renderRunHtmlReport,
  type TerminalOutcome,
} from './run-events';
import { finalizeRunRetention } from './run-reliability';

export type LiveServiceProviderId = 'github' | 'synthetic-local';

type LiveServiceProvider = {
  readonly id: LiveServiceProviderId;
  readonly kind: 'real' | 'synthetic';
  readonly label: string;
  readonly credentialEnvironmentVariable: string;
  readonly endpoint: string;
  readonly method: 'GET';
  readonly allowedRedirects: readonly string[] | 'same-origin-path';
  readonly validateResponse: (status: number, body: unknown) => boolean;
};

const providers = Object.freeze({
  github: Object.freeze({
    id: 'github',
    kind: 'real',
    label: 'GitHub account API',
    credentialEnvironmentVariable: 'OGI_LIVE_GITHUB_TOKEN',
    endpoint: 'https://api.github.com/user',
    method: 'GET',
    allowedRedirects: Object.freeze([] as string[]),
    validateResponse: (status: number) => status === 200,
  }),
  'synthetic-local': Object.freeze({
    id: 'synthetic-local',
    kind: 'synthetic',
    label: 'Synthetic local provider',
    credentialEnvironmentVariable: 'OGI_LIVE_SYNTHETIC_TOKEN',
    endpoint: 'http://127.0.0.1/health',
    method: 'GET',
    allowedRedirects: 'same-origin-path',
    validateResponse: (status: number, body: unknown) =>
      status === 200 &&
      typeof body === 'object' &&
      body !== null &&
      (body as { healthy?: unknown }).healthy === true,
  }),
}) satisfies Readonly<Record<LiveServiceProviderId, LiveServiceProvider>>;

const sensitiveKey =
  /(?:authorization|credential|password|secret|token|api[-_]?key|cookie)/i;
const minimumSecretLength = 8;

const percentCaseVariants = (value: string) => [
  value,
  value.replace(/%[0-9a-f]{2}/gi, (entry) => entry.toUpperCase()),
  value.replace(/%[0-9a-f]{2}/gi, (entry) => entry.toLowerCase()),
];

const escapeRegularExpression = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const caseFlexibleHex = (value: string) =>
  [...value]
    .map((character) =>
      /[a-f]/i.test(character)
        ? `[${character.toLowerCase()}${character.toUpperCase()}]`
        : character
    )
    .join('');

function percentEncodingPattern(value: string) {
  let pattern = '';
  for (let index = 0; index < value.length; index += 1) {
    const encodedPercentToken = value
      .slice(index)
      .match(/^%25(?:25)*[0-9a-f]{2}/i)?.[0];
    if (encodedPercentToken) {
      pattern += caseFlexibleHex(encodedPercentToken);
      index += encodedPercentToken.length - 1;
    } else if (
      value[index] === '%' &&
      /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))
    ) {
      const token = value.slice(index + 1, index + 3);
      pattern += `%${caseFlexibleHex(token)}`;
      index += 2;
    } else {
      pattern += escapeRegularExpression(value.charAt(index));
    }
  }
  return pattern;
}

function canonicalPercentSecretPatterns(secrets: readonly string[]) {
  const patterns = new Set<string>();
  for (const candidate of secrets) {
    if (candidate.length < minimumSecretLength) continue;
    for (const secret of new Set([
      candidate,
      candidate.normalize('NFC'),
      candidate.normalize('NFD'),
      candidate.normalize('NFKC'),
      candidate.normalize('NFKD'),
    ])) {
      let uriEncoded = encodeURIComponent(secret);
      let formEncoded = new URLSearchParams({ value: secret })
        .toString()
        .slice('value='.length);
      for (let depth = 0; depth < 3; depth += 1) {
        patterns.add(percentEncodingPattern(uriEncoded));
        patterns.add(percentEncodingPattern(formEncoded));
        uriEncoded = encodeURIComponent(uriEncoded);
        formEncoded = encodeURIComponent(formEncoded);
      }
    }
  }
  return [...patterns]
    .sort((left, right) => right.length - left.length)
    .map((pattern) => new RegExp(pattern, 'g'));
}

export function generateSecretVariants(secrets: readonly string[]) {
  const variants = new Set<string>();
  for (const candidate of secrets) {
    if (candidate.length < minimumSecretLength) continue;
    const normalizedSecrets = new Set([
      candidate,
      candidate.normalize('NFC'),
      candidate.normalize('NFD'),
      candidate.normalize('NFKC'),
      candidate.normalize('NFKD'),
    ]);
    for (const secret of normalizedSecrets) {
      const bytes = Buffer.from(secret);
      const base64 = bytes.toString('base64');
      const base64UrlPadded = base64.replaceAll('+', '-').replaceAll('/', '_');
      const encodedValues = new Set([
        secret,
        ...percentCaseVariants(encodeURIComponent(secret)),
        ...percentCaseVariants(
          new URLSearchParams({ value: secret })
            .toString()
            .slice('value='.length)
        ),
        base64,
        base64.replace(/=+$/, ''),
        base64UrlPadded,
        base64UrlPadded.replace(/=+$/, ''),
        bytes.toString('hex'),
        bytes.toString('hex').toUpperCase(),
      ]);
      for (const value of encodedValues) {
        if (value.length < minimumSecretLength) continue;
        variants.add(value);
        variants.add(`Bearer ${value}`);
        variants.add(`Basic ${value}`);
        variants.add(`Authorization: Bearer ${value}`);
        variants.add(`Authorization: Basic ${value}`);
        variants.add(`X-Api-Key: ${value}`);
        variants.add(`Cookie: session=${value}`);
      }
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

export function createSecretRedactor(secrets: readonly string[]) {
  const replacements = generateSecretVariants(secrets);
  const canonicalPercentPatterns = canonicalPercentSecretPatterns(secrets);

  const text = (input: string) => {
    let output = input;
    for (const replacement of replacements) {
      output = output.replaceAll(replacement, '[REDACTED]');
    }
    for (const pattern of canonicalPercentPatterns) {
      output = output.replace(pattern, '[REDACTED]');
    }
    output = output
      .replace(
        /(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;]+/gi,
        '$1[REDACTED]'
      )
      .replace(
        /((?:x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*)[^\r\n,;]+/gi,
        '$1[REDACTED]'
      )
      .replace(/(https?:\/\/)[^/@\s"']+@/gi, '$1[REDACTED]@')
      .replace(
        /([?&](?:access_token|api_key|apikey|credential|location|password|redirect|secret|token|uri|url)=)[^&#\s]*/gi,
        '$1[REDACTED]'
      );
    return output;
  };

  const value = (input: unknown, key = ''): unknown => {
    if (sensitiveKey.test(key) && input !== undefined && input !== null) {
      return '[REDACTED]';
    }
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map((entry) => value(entry));
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input).map(([entryKey, entryValue]) => [
          entryKey,
          value(entryValue, entryKey),
        ])
      );
    }
    return input;
  };

  const artifactName = (input: string) =>
    basename(text(input))
      .replaceAll('[REDACTED]', 'REDACTED')
      .replace(/[^a-zA-Z0-9._-]/g, '-');

  return { text, value, artifactName };
}

export function prepareLiveServiceEnvironment(
  environment: NodeJS.ProcessEnv,
  explicit?: { credential: string; provider: LiveServiceProviderId }
): NodeJS.ProcessEnv {
  const prepared = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('OGI_LIVE_'))
  );
  if (explicit) {
    prepared.OGI_LIVE_SERVICE_CREDENTIAL = explicit.credential;
  }
  return prepared;
}

const ciEnvironmentVariables = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'TF_BUILD',
  'JENKINS_URL',
  'OGI_E2E_DETERMINISTIC_ONLY',
] as const;

const activeEnvironmentMarker = (value: string | undefined) =>
  value !== undefined &&
  value.trim() !== '' &&
  !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

function assertLiveServiceAllowed(
  provider: LiveServiceProvider,
  environment: NodeJS.ProcessEnv
) {
  if (
    provider.id !== 'synthetic-local' &&
    ciEnvironmentVariables.some((key) =>
      activeEnvironmentMarker(environment[key])
    )
  ) {
    throw new Error('Live Service Scenarios are disabled in shared CI');
  }
}

export function resolveLiveServiceRequest(options: {
  provider: string;
  confirmed: boolean;
  environment: NodeJS.ProcessEnv;
}) {
  const provider = providers[options.provider as LiveServiceProviderId];
  if (!Object.hasOwn(providers, options.provider) || !provider) {
    throw new Error(`Unknown Live Service provider: ${options.provider}`);
  }
  if (!options.confirmed) {
    throw new Error(
      'Live Service Scenario requires explicit confirmation of real external calls'
    );
  }
  assertLiveServiceAllowed(provider, options.environment);
  const credential =
    options.environment[provider.credentialEnvironmentVariable] ?? '';
  if (credential.trim().length < 8) {
    throw new Error(
      `${provider.credentialEnvironmentVariable} is required and must be explicitly supplied`
    );
  }
  return { provider, credential };
}

type SyntheticEndpointPolicy = {
  origin: string;
  pathname: string;
};

function parseSyntheticEndpoint(
  endpoint: string,
  policy?: SyntheticEndpointPolicy
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      'Synthetic Live Service endpoint must use uncredentialed literal loopback HTTP'
    );
  }
  if (
    policy &&
    (url.origin !== policy.origin || url.pathname !== policy.pathname)
  ) {
    throw new Error(
      'Synthetic Live Service redirect must preserve the exact loopback origin and path'
    );
  }
  return url;
}

class LiveServiceCancellation extends Error {
  constructor() {
    super('Live Service Scenario was cancelled by the user');
  }
}

async function fetchRealProvider(options: {
  provider: (typeof providers)['github'];
  credential: string;
  signal: AbortSignal;
  cancellationRequested: () => boolean;
  redirects: Array<{
    status: number;
    from: string;
    location: string;
    to: string;
  }>;
}) {
  const registeredEndpoint = new URL(options.provider.endpoint);
  const allowedRedirects = new Set(options.provider.allowedRedirects);
  const visited = new Set<string>();
  let current = registeredEndpoint;
  for (let hop = 0; hop <= 5; hop += 1) {
    if (options.cancellationRequested()) throw new LiveServiceCancellation();
    if (visited.has(current.href)) {
      throw new Error('Real Live Service provider redirect loop detected');
    }
    visited.add(current.href);
    const sameCredentialOrigin = current.origin === registeredEndpoint.origin;
    const response = await fetch(current, {
      method: options.provider.method,
      redirect: 'manual',
      headers: {
        ...(sameCredentialOrigin
          ? { authorization: `Bearer ${options.credential}` }
          : {}),
        accept: 'application/json',
        'user-agent': 'OpenGameInstaller-E2E-Live-Service',
      },
      signal: options.signal,
    });
    if (options.cancellationRequested()) {
      await response.body?.cancel();
      throw new LiveServiceCancellation();
    }
    if (response.status < 300 || response.status > 399) {
      return { response, finalUrl: current.href };
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    const evidence = {
      status: response.status,
      from: current.href,
      location: location ?? '[missing]',
      to: '[rejected]',
    };
    options.redirects.push(evidence);
    if (!location) {
      throw new Error(
        'Real Live Service provider redirect is missing Location'
      );
    }
    if (hop === 5) {
      throw new Error('Real Live Service provider redirect limit exceeded');
    }
    const target = new URL(location, current);
    if (
      target.protocol !== 'https:' ||
      target.username !== '' ||
      target.password !== '' ||
      !allowedRedirects.has(target.href)
    ) {
      throw new Error(
        'Real Live Service provider redirect is not in the registered redirect allowlist'
      );
    }
    evidence.to = target.href;
    current = target;
  }
  throw new Error('Real Live Service provider redirect limit exceeded');
}

async function fetchSyntheticProvider(options: {
  endpoint: string;
  method: 'GET';
  credential: string;
  signal: AbortSignal;
  cancellationRequested: () => boolean;
  redirects: Array<{
    status: number;
    from: string;
    location: string;
    to: string;
  }>;
}) {
  const initial = parseSyntheticEndpoint(options.endpoint);
  const policy = { origin: initial.origin, pathname: initial.pathname };
  const visited = new Set<string>();
  let current = initial;
  for (let hop = 0; hop <= 5; hop += 1) {
    if (options.cancellationRequested()) throw new LiveServiceCancellation();
    if (visited.has(current.href)) {
      throw new Error('Synthetic Live Service redirect loop detected');
    }
    visited.add(current.href);
    const response = await fetch(current, {
      method: options.method,
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${options.credential}`,
        accept: 'application/json',
        'user-agent': 'OpenGameInstaller-E2E-Live-Service',
      },
      signal: options.signal,
    });
    if (options.cancellationRequested()) {
      await response.body?.cancel();
      throw new LiveServiceCancellation();
    }
    if (response.status < 300 || response.status > 399) {
      return { response, finalUrl: current.href };
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    const evidence = {
      status: response.status,
      from: current.href,
      location: location ?? '[missing]',
      to: '[rejected]',
    };
    options.redirects.push(evidence);
    if (!location) {
      throw new Error('Synthetic Live Service redirect is missing Location');
    }
    if (location.startsWith('//')) {
      throw new Error(
        'Synthetic Live Service protocol-relative redirect is not allowed'
      );
    }
    if (hop === 5) {
      throw new Error('Synthetic Live Service redirect limit exceeded');
    }
    const target = parseSyntheticEndpoint(
      new URL(location, current).href,
      policy
    );
    evidence.to = target.href;
    current = target;
  }
  throw new Error('Synthetic Live Service redirect limit exceeded');
}

type LiveServiceExecutionBase = {
  confirmed: boolean;
  credential: string;
  runRoot?: string;
  environment?: NodeJS.ProcessEnv;
  cancellationPath?: string;
  onStarted?: (announcement: {
    runId: string;
    sandboxDirectory: string;
    eventLogPath: string;
  }) => void;
};

export type LiveServiceExecutionOptions = LiveServiceExecutionBase &
  (
    | { provider: 'github'; endpoint?: never }
    | { provider: 'synthetic-local'; endpoint?: string }
  );

export async function executeLiveServiceScenario(
  options: LiveServiceExecutionOptions
) {
  if (!options.confirmed) {
    throw new Error('Live Service Scenario requires explicit confirmation');
  }
  if (options.credential.trim().length < 8) {
    throw new Error('Live Service credential is missing or invalid');
  }
  const provider = providers[options.provider];
  if (!provider)
    throw new Error(`Unknown Live Service provider: ${options.provider}`);
  if (provider.kind === 'real' && options.endpoint !== undefined) {
    throw new Error(
      `${provider.id} Live Service provider does not allow an endpoint override`
    );
  }
  assertLiveServiceAllowed(provider, process.env);
  if (options.environment) {
    assertLiveServiceAllowed(provider, options.environment);
  }
  const endpoint =
    provider.kind === 'real'
      ? provider.endpoint
      : (options.endpoint ?? provider.endpoint);
  if (provider.kind === 'synthetic') parseSyntheticEndpoint(endpoint);

  const runId = randomUUID();
  const runRoot = resolve(
    options.runRoot ??
      process.env.OGI_E2E_RUN_ROOT ??
      join(tmpdir(), 'ogi-e2e-runs')
  );
  mkdirSync(runRoot, { recursive: true });
  const sandboxDirectory = mkdtempSync(
    join(runRoot, `live-service-${provider.id}-${runId}-`)
  );
  const artifactsDirectory = join(sandboxDirectory, 'artifacts');
  mkdirSync(artifactsDirectory);
  const eventLogPath = join(sandboxDirectory, 'events.jsonl');
  const descriptorPath = join(sandboxDirectory, 'run-descriptor.json');
  const logPath = join(artifactsDirectory, 'live-service-provider.log');
  const healthPath = join(
    artifactsDirectory,
    'external-integration-health.json'
  );
  const screenshotPath = join(artifactsDirectory, 'live-service-status.png');
  const reportPath = join(sandboxDirectory, 'report.html');
  const redactor = createSecretRedactor([options.credential]);
  const writeEvent = makeRunEventWriter(eventLogPath, runId, 0, redactor);
  options.onStarted?.({ runId, sandboxDirectory, eventLogPath });
  const relativeArtifact = (path: string) =>
    path.slice(sandboxDirectory.length + 1).replaceAll('\\', '/');

  writeFileSync(
    descriptorPath,
    `${JSON.stringify(
      {
        version: 1,
        scenario: 'live-service-provider-health',
        provider: provider.id,
        endpoint: redactor.text(endpoint),
        credential: '[REDACTED]',
        credentialSource: provider.credentialEnvironmentVariable,
        sandboxDirectory,
      },
      null,
      2
    )}\n`
  );

  writeEvent({ type: 'run.started', payload: { platform: process.platform } });
  writeEvent({
    type: 'scenario.started',
    payload: {
      scenarioId: `live-service-${provider.id}`,
      kind: 'Live Service Scenario',
    },
  });
  writeEvent({
    type: 'attempt.started',
    payload: { scenarioId: `live-service-${provider.id}`, attempt: 1 },
  });
  writeEvent({
    type: 'step.started',
    payload: {
      stepId: 'check-external-integration-health',
      name: `Check ${provider.label} external integration health`,
    },
  });

  let responseStatus = 0;
  let responseBody: unknown = null;
  let responseHeaders: Record<string, string> = {};
  let finalUrl = endpoint;
  let errorDetail: string | undefined;
  let cancelled = false;
  let redirects: Array<{
    status: number;
    from: string;
    location: string;
    to: string;
  }> = [];
  const cancellationController = new AbortController();
  let cancellationObserved = false;
  const cancellationRequested = () => {
    if (
      !cancellationObserved &&
      options.cancellationPath &&
      existsSync(options.cancellationPath)
    ) {
      cancellationObserved = true;
      cancellationController.abort(new LiveServiceCancellation());
    }
    return cancellationObserved;
  };
  const cancellationWatcher = options.cancellationPath
    ? setInterval(cancellationRequested, 20)
    : undefined;
  const timeout = setTimeout(
    () => cancellationController.abort(new Error('Provider request timed out')),
    30_000
  );
  try {
    if (cancellationRequested()) throw new LiveServiceCancellation();
    const providerResponse =
      provider.kind === 'synthetic'
        ? await fetchSyntheticProvider({
            endpoint,
            method: provider.method,
            credential: options.credential,
            signal: cancellationController.signal,
            cancellationRequested,
            redirects,
          })
        : await fetchRealProvider({
            provider,
            credential: options.credential,
            signal: cancellationController.signal,
            cancellationRequested,
            redirects,
          });
    finalUrl = providerResponse.finalUrl;
    responseStatus = providerResponse.response.status;
    responseHeaders = Object.fromEntries(
      providerResponse.response.headers.entries()
    );
    const rawBody = await providerResponse.response.text();
    if (cancellationRequested()) throw new LiveServiceCancellation();
    try {
      responseBody = JSON.parse(rawBody);
    } catch {
      responseBody = rawBody;
    }
  } catch (cause) {
    cancelled =
      cancellationObserved || cause instanceof LiveServiceCancellation;
    errorDetail = redactor.text(
      cancelled
        ? 'Live Service Scenario was cancelled by the user'
        : cause instanceof Error
          ? cause.message
          : String(cause)
    );
  } finally {
    if (cancellationWatcher) clearInterval(cancellationWatcher);
    clearTimeout(timeout);
  }

  writeFileSync(
    logPath,
    `${redactor.text(
      JSON.stringify(
        redactor.value({
          request: {
            method: 'GET',
            url: endpoint,
            finalUrl,
            authorization: `Bearer ${options.credential}`,
          },
          redirects,
          response: {
            status: responseStatus,
            headers: responseHeaders,
            body: responseBody,
          },
          error: errorDetail,
        }),
        null,
        2
      )
    )}\n`
  );

  const healthy =
    !cancelled &&
    errorDetail === undefined &&
    provider.validateResponse(responseStatus, responseBody);
  const outcome: TerminalOutcome = cancelled
    ? 'Cancelled'
    : healthy
      ? 'Passed'
      : 'Failed';
  const health = {
    version: 1,
    provider: provider.id,
    status: cancelled
      ? ('Not checked' as const)
      : healthy
        ? ('Healthy' as const)
        : ('Unhealthy' as const),
    checkedAt: new Date().toISOString(),
    responseStatus,
    error: errorDetail,
    deterministicCoverage: 'Not evaluated' as const,
  };
  writeFileSync(healthPath, `${JSON.stringify(health, null, 2)}\n`);
  await sharp({
    create: {
      width: 960,
      height: 540,
      channels: 4,
      background: healthy ? '#edf7f1' : '#fff1f0',
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg"><text x="60" y="120" font-size="36" font-family="sans-serif" fill="#17211b">Live Service Scenario</text><text x="60" y="190" font-size="26" font-family="sans-serif" fill="#17211b">${provider.label}</text><text x="60" y="260" font-size="28" font-family="sans-serif" fill="#17211b">External integration: ${health.status}</text><text x="60" y="320" font-size="22" font-family="sans-serif" fill="#46534b">Credential: [REDACTED]</text><text x="60" y="380" font-size="22" font-family="sans-serif" fill="#46534b">Deterministic coverage: not evaluated</text></svg>`
        ),
      },
    ])
    .png()
    .toFile(screenshotPath);

  for (const [artifactType, path] of [
    ['run-descriptor', descriptorPath],
    ['main-log', logPath],
    ['live-service-health', healthPath],
    ['screenshot', screenshotPath],
  ] as const) {
    writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType,
        path: relativeArtifact(path),
        ...(artifactType === 'screenshot'
          ? { stepId: 'check-external-integration-health' }
          : {}),
      },
    });
  }
  if (!cancelled) {
    writeEvent({
      type: 'external-integration.health',
      payload: {
        provider: provider.id,
        status: healthy ? 'Healthy' : 'Unhealthy',
        deterministicCoverage: 'Not evaluated',
        ...(responseStatus > 0 ? { responseStatus } : {}),
        ...(errorDetail ? { error: errorDetail } : {}),
      },
    });
  }
  writeEvent({
    type: 'step.completed',
    payload: {
      stepId: 'check-external-integration-health',
      outcome: cancelled ? 'Cancelled' : healthy ? 'Passed' : 'Failed',
      ...(healthy
        ? {}
        : {
            error: errorDetail ?? `Provider returned status ${responseStatus}`,
          }),
    },
  });
  writeEvent({ type: 'attempt.completed', payload: { attempt: 1, outcome } });
  writeEvent({
    type: 'scenario.completed',
    payload: { scenarioId: `live-service-${provider.id}`, outcome },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
  writeFileSync(reportPath, renderRunHtmlReport(eventLogPath, outcome));
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'html-report',
      path: relativeArtifact(reportPath),
    },
  });
  writeFileSync(
    join(sandboxDirectory, 'summary.json'),
    `${JSON.stringify(
      {
        version: 1,
        runId,
        outcome,
        externalIntegrationHealth: health,
        deterministicCoverage: 'Not evaluated',
        eventCount: readRunEvents(eventLogPath).length,
      },
      null,
      2
    )}\n`
  );
  finalizeRunRetention({
    runId,
    sandboxDirectory,
    outcome,
    pinned: true,
  });

  return {
    runId,
    sandboxDirectory,
    eventLogPath,
    outcome,
    externalIntegrationHealth: {
      provider: provider.id,
      status: health.status,
      deterministicCoverage: 'Not evaluated' as const,
    },
  };
}

export const LIVE_SERVICE_PROVIDERS = Object.values(providers).map(
  ({ id, label, credentialEnvironmentVariable }) => ({
    id,
    label,
    credentialEnvironmentVariable,
  })
);
