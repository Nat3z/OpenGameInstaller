import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import {
  type RunEventInput,
  readRunEvents,
  replayRunEventLog,
  TERMINAL_OUTCOMES,
  type TerminalOutcome,
} from './run-events';

export type ProcessLeak = { pid: number; name: string };
export type AttemptOutcome = Exclude<TerminalOutcome, 'Flaky' | 'Skipped'>;

type ArtifactType = Extract<
  RunEventInput,
  { type: 'artifact.created' }
>['payload']['artifactType'];

function reliableAttemptArtifactType(
  attemptDirectory: string,
  path: string
): ArtifactType | undefined {
  const name = basename(path);
  if (name === 'events.jsonl') return 'run-event-log';
  if (name === 'run-descriptor.json') return 'run-descriptor';
  if (name === 'report.html') return 'html-report';
  if (name === 'reliability.json') return 'reliability-report';
  if (name.includes('expected-assertion-exit'))
    return 'assertion-exit-evidence';
  if (name === 'retention.json') return 'retention-manifest';
  if (name === 'torrent-network-containment-assertion.json')
    return 'torrent-network-containment-assertion';
  if (name === 'torrent-network-isolation-assertion.json')
    return 'torrent-network-isolation-assertion';
  if (name === 'torrent-payload-manifest-assertion.json')
    return 'torrent-payload-manifest-assertion';
  const artifactPath = relative(attemptDirectory, path).split(/[\\/]/);
  if (
    name.endsWith('.png') &&
    artifactPath.length === 2 &&
    artifactPath[0] === 'artifacts'
  ) {
    return 'screenshot';
  }
  if (
    (name.endsWith('.log') || name.endsWith('.jsonl')) &&
    (artifactPath[0] === 'artifacts' ||
      artifactPath.join('/') === 'fixture-state/requests.jsonl' ||
      artifactPath.join('/') ===
        'installation/app/ogi-e2e-fixture-addon/installation.log')
  ) {
    return 'main-log';
  }
  return undefined;
}

export function recordReliableAttemptEvidence(options: {
  aggregateDirectory: string;
  attemptDirectory: string;
  attempt: number;
  evidencePaths: readonly string[];
  writeEvent: (event: RunEventInput) => unknown;
}) {
  for (const path of options.evidencePaths) {
    const attemptRelativePath = relative(options.attemptDirectory, path);
    if (
      attemptRelativePath.startsWith(`..${sep}`) ||
      attemptRelativePath === '..' ||
      isAbsolute(attemptRelativePath)
    ) {
      throw new Error(
        'Product Journey artifact link escaped its attempt directory'
      );
    }
    const artifactType = reliableAttemptArtifactType(
      options.attemptDirectory,
      path
    );
    if (!artifactType) continue;
    const aggregateRelativePath = relative(options.aggregateDirectory, path);
    if (
      aggregateRelativePath.startsWith(`..${sep}`) ||
      aggregateRelativePath === '..' ||
      isAbsolute(aggregateRelativePath)
    ) {
      throw new Error(
        'Product Journey artifact link escaped its aggregate directory'
      );
    }
    options.writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType,
        path: aggregateRelativePath.replaceAll('\\', '/'),
        attempt: options.attempt,
      },
    });
  }
}

export function readReliableAttemptEvidenceSummary(eventLogPath: string) {
  return readRunEvents(eventLogPath).flatMap((event) =>
    event.type === 'artifact.created' && event.payload.attempt !== undefined
      ? [
          {
            attempt: event.payload.attempt,
            artifactType: event.payload.artifactType,
            path: event.payload.path,
          },
        ]
      : []
  );
}

export function resolveOfflineChromedriverPath(options: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  browserMajor?: string;
}) {
  const explicitPath = options.environment.OGI_CHROMEDRIVER_PATH;
  if (explicitPath) {
    if (!existsSync(explicitPath) || !statSync(explicitPath).isFile()) {
      throw new Error(`Pinned Chromedriver does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  const cacheRoot = options.environment.XDG_CACHE_HOME
    ? resolve(options.environment.XDG_CACHE_HOME)
    : options.environment.HOME
      ? join(options.environment.HOME, '.cache')
      : undefined;
  if (!cacheRoot) return undefined;
  const driverRoot = join(cacheRoot, 'chromedriver');
  if (!existsSync(driverRoot)) return undefined;
  if (options.platform !== 'linux' && options.platform !== 'win32') {
    return undefined;
  }
  const executableName =
    options.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
  const candidates: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name === executableName)
        candidates.push(path);
    }
  };
  visit(driverRoot, 0);
  const platformPrefix = options.platform === 'win32' ? 'win64' : 'linux';
  const compatibleCandidates = options.browserMajor
    ? candidates.filter((path) =>
        path.includes(`${platformPrefix}-${options.browserMajor}.`)
      )
    : candidates;
  return compatibleCandidates.sort().at(-1);
}

export type RetentionManifest = {
  version: 1;
  runId: string;
  createdAt: string;
  outcome: TerminalOutcome;
  pinned: boolean;
};

export type QuarantineMetadata = {
  issue: string;
  owner: string;
  expires: string;
};

export type ScenarioDisposition = {
  scenarioId: string;
  skip?: boolean;
  quarantine?: QuarantineMetadata;
};

const FAILURE_CLASS_OUTCOMES = new Set<TerminalOutcome>([
  'Failed',
  'Flaky',
  'Cancelled',
  'Aborted',
  'Infrastructure Failed',
]);

export function classifyRunOutcome(
  attempts: readonly AttemptOutcome[],
  infrastructure: { leaks?: readonly ProcessLeak[] } = {}
): TerminalOutcome {
  if ((infrastructure.leaks?.length ?? 0) > 0) {
    return 'Infrastructure Failed';
  }
  if (attempts.length === 0) return 'Aborted';
  if (attempts.some((outcome) => outcome === 'Infrastructure Failed')) {
    return 'Infrastructure Failed';
  }
  if (
    attempts.length === 2 &&
    attempts[0] === 'Failed' &&
    attempts[1] === 'Passed'
  ) {
    return 'Flaky';
  }
  if (attempts.includes('Cancelled')) return 'Cancelled';
  if (attempts.includes('Aborted')) return 'Aborted';
  return attempts.at(-1)!;
}

export function getRequiredCheckResult(outcome: TerminalOutcome) {
  const passed = outcome === 'Passed' || outcome === 'Skipped';
  return { passed, exitCode: passed ? 0 : 1 } as const;
}

export function writeExpectedAssertionExitConfirmation(
  path: string | undefined,
  exitCode: number,
  results: unknown
) {
  if (!path) return;
  const failed =
    typeof results === 'object' &&
    results !== null &&
    'failed' in results &&
    typeof results.failed === 'number'
      ? results.failed
      : undefined;
  if (exitCode === 1 && failed === 1) {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, exitCode, failed, completed: true })
    );
  } else {
    rmSync(path, { force: true });
  }
}

export function hasExpectedAssertionExitConfirmation(path: string) {
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;
    return (
      evidence.version === 1 &&
      evidence.exitCode === 1 &&
      evidence.failed === 1 &&
      evidence.completed === true
    );
  } catch {
    return false;
  }
}

export function classifyAttemptProcessFailure(
  failure: unknown,
  expectedAssertionExit: boolean
): Extract<AttemptOutcome, 'Failed' | 'Infrastructure Failed'> {
  if (
    !expectedAssertionExit ||
    typeof failure !== 'object' ||
    failure === null
  ) {
    return 'Infrastructure Failed';
  }
  const processFailure = failure as {
    _tag?: unknown;
    status?: unknown;
    signal?: unknown;
  };
  return typeof processFailure._tag === 'string' &&
    processFailure._tag.endsWith('ProcessExitError') &&
    processFailure.status === 1 &&
    processFailure.signal === null
    ? 'Failed'
    : 'Infrastructure Failed';
}

function parseManifest(path: string): RetentionManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RetentionManifest;
    if (
      value.version !== 1 ||
      typeof value.runId !== 'string' ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.outcome !== 'string' ||
      !TERMINAL_OUTCOMES.includes(value.outcome) ||
      typeof value.pinned !== 'boolean'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function finalizeRunRetention(options: {
  runId: string;
  sandboxDirectory: string;
  outcome: TerminalOutcome;
  createdAt?: string;
  pinned?: boolean;
  sessionRetained?: boolean;
  videoPaths?: readonly string[];
}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const manifest: RetentionManifest = {
    version: 1,
    runId: options.runId,
    createdAt,
    outcome: options.outcome,
    pinned: options.pinned ?? false,
  };
  if (
    !options.pinned &&
    !options.sessionRetained &&
    !FAILURE_CLASS_OUTCOMES.has(options.outcome)
  ) {
    for (const videoPath of options.videoPaths ?? []) {
      rmSync(videoPath, { force: true });
    }
    rmSync(options.sandboxDirectory, { recursive: true, force: true });
    return { retained: false, manifest };
  }
  mkdirSync(options.sandboxDirectory, { recursive: true });
  writeFileSync(
    join(options.sandboxDirectory, 'retention.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return { retained: true, manifest };
}

export function pinRetainedRun(sandboxDirectory: string, pinned = true) {
  const manifestPath = join(sandboxDirectory, 'retention.json');
  const manifest = parseManifest(manifestPath);
  if (!manifest) throw new Error('Retained run manifest is missing or invalid');
  const updated = { ...manifest, pinned };
  writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function recoverAbortedManifest(sandboxDirectory: string) {
  const eventLogPath = join(sandboxDirectory, 'events.jsonl');
  if (!existsSync(eventLogPath)) return undefined;
  try {
    const replay = replayRunEventLog(eventLogPath);
    if (replay.completed) return undefined;
    const startedAt =
      readRunEvents(eventLogPath).find((event) => event.type === 'run.started')
        ?.timestamp ?? new Date().toISOString();
    const manifest: RetentionManifest = {
      version: 1,
      runId: replay.runId,
      createdAt: startedAt,
      outcome: 'Aborted',
      pinned: false,
    };
    writeFileSync(
      join(sandboxDirectory, 'retention.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  } catch {
    return undefined;
  }
}

export function shouldApplyRunRetention(environment: NodeJS.ProcessEnv) {
  return environment.OGI_OBSERVER_SESSION_RETENTION !== '1';
}

export function applyRunRetention(
  rootDirectory: string,
  now = new Date(),
  newestCount = 20,
  ageDays = 14
) {
  if (!existsSync(rootDirectory)) return { kept: [], deleted: [] };
  const runs = readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sandboxDirectory = join(rootDirectory, entry.name);
      const manifestPath = join(sandboxDirectory, 'retention.json');
      const manifest =
        parseManifest(manifestPath) ?? recoverAbortedManifest(sandboxDirectory);
      if (manifest) {
        return { sandboxDirectory, manifest, unrecognized: false };
      }
      const statistics = statSync(sandboxDirectory);
      let pinned = false;
      if (existsSync(manifestPath)) {
        try {
          pinned =
            JSON.parse(readFileSync(manifestPath, 'utf8')).pinned === true;
        } catch {
          // An unreadable manifest is still eligible for age-based orphan cleanup.
        }
      }
      return {
        sandboxDirectory,
        unrecognized: true,
        manifest: {
          version: 1 as const,
          runId: entry.name,
          createdAt: statistics.mtime.toISOString(),
          outcome: 'Aborted' as const,
          pinned,
        },
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.manifest.createdAt) -
        Date.parse(left.manifest.createdAt)
    );
  const newest = new Set(
    runs.slice(0, newestCount).map((run) => run.sandboxDirectory)
  );
  const cutoff = now.getTime() - ageDays * 86_400_000;
  const kept: string[] = [];
  const deleted: string[] = [];
  const activeSafetyCutoff = now.getTime() - 5 * 60_000;
  for (const run of runs) {
    const createdAt = Date.parse(run.manifest.createdAt);
    const keep =
      run.manifest.pinned ||
      newest.has(run.sandboxDirectory) ||
      createdAt >= cutoff ||
      (run.unrecognized && createdAt >= activeSafetyCutoff);
    if (keep) {
      kept.push(run.sandboxDirectory);
    } else {
      rmSync(run.sandboxDirectory, { recursive: true, force: true });
      deleted.push(run.sandboxDirectory);
    }
  }
  return { kept, deleted };
}

export function validateScenarioDisposition(
  disposition: ScenarioDisposition,
  now = new Date()
): { outcome: 'Passed' | 'Skipped'; quarantined: boolean } {
  if (!disposition.skip) {
    if (disposition.quarantine) {
      throw new Error(
        'Quarantine metadata is only valid for a skipped scenario'
      );
    }
    return { outcome: 'Passed', quarantined: false };
  }
  const quarantine = disposition.quarantine;
  if (!quarantine) {
    throw new Error(`Untracked skip is prohibited: ${disposition.scenarioId}`);
  }
  const issue = quarantine.issue.trim();
  const linkedIssue =
    /^https?:\/\//.test(issue) ||
    /^#\d+$/.test(issue) ||
    /(^|\/)issues?\/[^/]+$/.test(issue) ||
    issue.endsWith('.md');
  if (!linkedIssue || !quarantine.owner.trim()) {
    throw new Error('Quarantine requires a linked issue and named owner');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quarantine.expires)) {
    throw new Error('Quarantine expiry must use YYYY-MM-DD');
  }
  const expiry = new Date(`${quarantine.expires}T23:59:59.999Z`);
  if (
    Number.isNaN(expiry.getTime()) ||
    expiry.toISOString().slice(0, 10) !== quarantine.expires
  ) {
    throw new Error('Quarantine expiry is invalid');
  }
  if (expiry.getTime() < now.getTime()) {
    throw new Error(`Quarantine expired on ${quarantine.expires}`);
  }
  return { outcome: 'Skipped', quarantined: true };
}

type TestControlKind = 'framework' | 'focused' | 'skipped';
type ResolvedTestControl = TestControlKind | 'namespace';
const KNOWN_NULLISH = Symbol('known-nullish');
const KNOWN_FALSY = Symbol('known-falsy');
const KNOWN_TRUTHY = Symbol('known-truthy');
type TestControlState =
  | typeof KNOWN_NULLISH
  | typeof KNOWN_FALSY
  | typeof KNOWN_TRUTHY;
type TestControlAggregate =
  | { kind: 'array'; elements: Array<TestControlValue | undefined> }
  | { kind: 'object'; properties: Map<string, TestControlValue> }
  | { kind: 'union'; values: TestControlValue[] };
type TestControlValue =
  | ResolvedTestControl
  | TestControlAggregate
  | TestControlState
  | false;
type TestControlBinding = TestControlValue;

type TestControlScope = {
  parent?: TestControlScope;
  functionScope: TestControlScope;
  bindings: Map<string, TestControlBinding>;
};

const FRAMEWORK_MODULES = new Set(['bun:test', '@playwright/test', 'vitest']);
const FRAMEWORK_CONTROLS = new Set(['describe', 'it', 'test']);
const FOCUSED_CONTROLS = new Set(['fdescribe', 'fit', 'ftest']);
const SKIPPED_CONTROLS = new Set(['xdescribe', 'xit', 'xtest']);

function getPropertyName(node: ts.PropertyName | ts.Expression) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  )
    return node.text;
  return undefined;
}

function getNamedControl(name: string): TestControlKind | undefined {
  if (FRAMEWORK_CONTROLS.has(name)) return 'framework';
  if (FOCUSED_CONTROLS.has(name)) return 'focused';
  if (SKIPPED_CONTROLS.has(name)) return 'skipped';
  return undefined;
}

function combineTestControlValues(
  ...values: Array<TestControlValue | undefined>
): TestControlValue | undefined {
  const combined: TestControlValue[] = [];
  for (const value of values) {
    if (typeof value === 'object' && value.kind === 'union') {
      combined.push(...value.values);
    } else if (value !== undefined && value !== false) {
      combined.push(value);
    }
  }
  if (combined.length === 0) return undefined;
  if (combined.length === 1) return combined[0];
  return { kind: 'union', values: combined };
}

function getPropertyControl(
  target: TestControlValue | undefined,
  property: string | undefined
): TestControlValue | undefined {
  if (!property || target === false) return undefined;
  if (typeof target === 'object') {
    if (target.kind === 'union') {
      return combineTestControlValues(
        ...target.values.map((value) => getPropertyControl(value, property))
      );
    }
    if (target.kind === 'object') return target.properties.get(property);
    const index = Number(property);
    return Number.isInteger(index) && index >= 0
      ? target.elements[index]
      : undefined;
  }
  if (target === 'namespace') return getNamedControl(property);
  if (target === 'framework') {
    if (property === 'only') return 'focused';
    if (property === 'skip' || property === 'todo') return 'skipped';
  }
  if (target === 'focused' || target === 'skipped') return target;
  return undefined;
}

function lookupTestControlBinding(
  scope: TestControlScope,
  name: string
): TestControlBinding | undefined {
  for (
    let current: TestControlScope | undefined = scope;
    current;
    current = current.parent
  ) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return getNamedControl(name);
}

function getStaticExpressionState(expression: ts.Expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return 'truthy' as const;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return 'falsy' as const;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return 'nullish' as const;
  if (ts.isStringLiteral(expression)) {
    return expression.text.length > 0
      ? ('truthy' as const)
      : ('falsy' as const);
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text) === 0
      ? ('falsy' as const)
      : ('truthy' as const);
  }
  return 'unknown' as const;
}

function getTestControlValueState(
  value: TestControlValue | undefined
): 'truthy' | 'falsy' | 'nullish' | 'unknown' {
  if (value === KNOWN_NULLISH) return 'nullish' as const;
  if (value === KNOWN_FALSY) return 'falsy' as const;
  if (value === KNOWN_TRUTHY) return 'truthy' as const;
  if (typeof value === 'string') return 'truthy' as const;
  if (typeof value === 'object' && value.kind !== 'union') {
    return 'truthy' as const;
  }
  if (typeof value === 'object' && value.kind === 'union') {
    const states = new Set(value.values.map(getTestControlValueState));
    if (states.size === 1) return states.values().next().value ?? 'unknown';
  }
  return 'unknown' as const;
}

function resolveLogicalAssignmentValue(
  operator: ts.SyntaxKind,
  left: TestControlValue | undefined,
  right: TestControlValue | undefined,
  leftState: ReturnType<typeof getStaticExpressionState>
) {
  const state =
    leftState === 'unknown' ? getTestControlValueState(left) : leftState;
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    if (state === 'nullish') return right;
    if (state === 'truthy' || state === 'falsy') return left;
  } else if (operator === ts.SyntaxKind.BarBarEqualsToken) {
    if (state === 'falsy' || state === 'nullish') return right;
    if (state === 'truthy') return left;
  } else if (operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
    if (state === 'truthy') return right;
    if (state === 'falsy' || state === 'nullish') return left;
  }
  return combineTestControlValues(left, right);
}

function isLogicalAssignmentOperator(operator: ts.SyntaxKind) {
  return (
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );
}

function resolveTestControlValue(
  expression: ts.Expression,
  scope: TestControlScope
): TestControlValue | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return resolveTestControlValue(expression.expression, scope);
  }
  if (ts.isIdentifier(expression)) {
    return lookupTestControlBinding(scope, expression.text) || undefined;
  }
  const staticState = getStaticExpressionState(expression);
  if (staticState === 'nullish') return KNOWN_NULLISH;
  if (staticState === 'falsy') return KNOWN_FALSY;
  if (staticState === 'truthy') return KNOWN_TRUTHY;
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isClassExpression(expression)
  ) {
    return KNOWN_TRUTHY;
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = getStaticExpressionState(expression.condition);
    if (condition === 'truthy') {
      return resolveTestControlValue(expression.whenTrue, scope);
    }
    if (condition === 'falsy' || condition === 'nullish') {
      return resolveTestControlValue(expression.whenFalse, scope);
    }
    return combineTestControlValues(
      resolveTestControlValue(expression.whenTrue, scope),
      resolveTestControlValue(expression.whenFalse, scope)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = resolveTestControlValue(expression.left, scope);
    const right = resolveTestControlValue(expression.right, scope);
    const leftState = getStaticExpressionState(expression.left);
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      if (leftState === 'truthy' || (left !== undefined && left !== false)) {
        return left;
      }
      if (leftState === 'falsy' || leftState === 'nullish') return right;
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      if (leftState === 'falsy' || leftState === 'nullish') return left;
      if (leftState === 'truthy' || (left !== undefined && left !== false)) {
        return right;
      }
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      if (leftState === 'nullish') return right;
      if (leftState === 'truthy' || leftState === 'falsy') return left;
    }
    return combineTestControlValues(left, right);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const elements: Array<TestControlValue | undefined> = [];
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) {
        elements.push(undefined);
      } else if (ts.isSpreadElement(element)) {
        const spread = resolveTestControlValue(element.expression, scope);
        if (typeof spread === 'object' && spread.kind === 'array') {
          elements.push(...spread.elements);
        } else {
          elements.push(undefined);
        }
      } else {
        elements.push(resolveTestControlValue(element, scope));
      }
    }
    return { kind: 'array', elements };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = new Map<string, TestControlValue>();
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = resolveTestControlValue(property.expression, scope);
        if (typeof spread === 'object' && spread.kind === 'object') {
          for (const [name, value] of spread.properties) {
            properties.set(name, value);
          }
        }
      } else if (ts.isPropertyAssignment(property)) {
        const name = getPropertyName(property.name);
        const value = resolveTestControlValue(property.initializer, scope);
        if (name && value) properties.set(name, value);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const value = lookupTestControlBinding(scope, property.name.text);
        if (value) properties.set(property.name.text, value);
      } else if (ts.isMethodDeclaration(property)) {
        const name = getPropertyName(property.name);
        if (name) properties.set(name, KNOWN_TRUTHY);
      }
    }
    return { kind: 'object', properties };
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const target = resolveTestControlValue(expression.expression, scope);
    const property = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : expression.argumentExpression
        ? getPropertyName(expression.argumentExpression)
        : undefined;
    return getPropertyControl(target, property);
  }
  if (ts.isCallExpression(expression)) {
    const called = resolveTestControlValue(expression.expression, scope);
    return typeof called === 'string' ? called : undefined;
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return resolveTestControlValue(expression.right, scope);
    }
    if (isLogicalAssignmentOperator(expression.operatorToken.kind)) {
      return resolveLogicalAssignmentValue(
        expression.operatorToken.kind,
        resolveTestControlValue(expression.left, scope),
        resolveTestControlValue(expression.right, scope),
        getStaticExpressionState(expression.left)
      );
    }
  }
  return undefined;
}

function resolveTestControl(
  expression: ts.Expression,
  scope: TestControlScope
): ResolvedTestControl | undefined {
  const value = resolveTestControlValue(expression, scope);
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value.kind !== 'union') return undefined;
  const controls = value.values.flatMap((candidate) =>
    typeof candidate === 'string' ? [candidate] : []
  );
  if (controls.includes('focused')) return 'focused';
  if (controls.includes('skipped')) return 'skipped';
  if (controls.includes('framework')) return 'framework';
  return controls.includes('namespace') ? 'namespace' : undefined;
}

export function validateScenarioSourceDispositions(
  sourcePaths: readonly string[],
  now = new Date()
) {
  for (const sourcePath of sourcePaths) {
    const source = readFileSync(sourcePath, 'utf8');
    const lines = source.split(/\r?\n/);
    const sourceFile = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const reportControl = (node: ts.Node, control: TestControlKind) => {
      if (control === 'framework') return;
      const lineNumber =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;
      if (control === 'focused') {
        throw new Error(
          `Focused test selection is prohibited: ${sourcePath}:${lineNumber}`
        );
      }
      const metadataText = lines
        .slice(Math.max(0, lineNumber - 6), lineNumber - 1)
        .join(' ');
      const metadata = metadataText.match(
        /@quarantine\s+issue=(\S+)\s+owner=(\S+)\s+expires=(\d{4}-\d{2}-\d{2})/
      );
      validateScenarioDisposition(
        {
          scenarioId: `${sourcePath}:${lineNumber}`,
          skip: true,
          ...(metadata
            ? {
                quarantine: {
                  issue: metadata[1]!,
                  owner: metadata[2]!,
                  expires: metadata[3]!,
                },
              }
            : {}),
        },
        now
      );
    };
    const createScope = (
      parent?: TestControlScope,
      functionScope = false
    ): TestControlScope => {
      const scope = {
        parent,
        bindings: new Map<string, TestControlBinding>(),
      } as TestControlScope;
      scope.functionScope =
        !parent || functionScope ? scope : parent.functionScope;
      return scope;
    };
    const declareBindingName = (
      name: ts.BindingName,
      scope: TestControlScope
    ) => {
      if (ts.isIdentifier(name)) {
        scope.bindings.set(name.text, false);
        return;
      }
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        declareBindingName(element.name, scope);
      }
    };
    const predeclareStatements = (
      statements: ts.NodeArray<ts.Statement>,
      scope: TestControlScope
    ) => {
      for (const statement of statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.name) scope.bindings.set(clause.name.text, false);
          if (clause?.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              scope.bindings.set(clause.namedBindings.name.text, false);
            } else {
              for (const element of clause.namedBindings.elements) {
                scope.bindings.set(element.name.text, false);
              }
            }
          }
        } else if (ts.isVariableStatement(statement)) {
          if (
            statement.declarationList.flags &
            (ts.NodeFlags.Let | ts.NodeFlags.Const)
          ) {
            for (const declaration of statement.declarationList.declarations) {
              declareBindingName(declaration.name, scope);
            }
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name
        ) {
          scope.bindings.set(statement.name.text, KNOWN_TRUTHY);
        }
      }
    };
    const predeclareFunctionVariables = (
      node: ts.Node,
      functionScope: TestControlScope
    ) => {
      const visit = (child: ts.Node) => {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (
          ts.isVariableDeclarationList(child) &&
          !(child.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))
        ) {
          for (const declaration of child.declarations) {
            declareBindingName(declaration.name, functionScope);
          }
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
    };
    const findBindingScope = (
      scope: TestControlScope,
      name: string
    ): TestControlScope | undefined => {
      for (
        let current: TestControlScope | undefined = scope;
        current;
        current = current.parent
      ) {
        if (current.bindings.has(name)) return current;
      }
      return undefined;
    };
    const assignIdentifier = (
      name: string,
      control: TestControlValue | undefined,
      scope: TestControlScope
    ) => {
      const bindingScope = findBindingScope(scope, name) ?? scope;
      bindingScope.bindings.set(name, control ?? false);
    };
    const assignBindingName = (
      name: ts.BindingName,
      control: TestControlValue | undefined,
      scope: TestControlScope
    ) => {
      if (ts.isIdentifier(name)) {
        assignIdentifier(name.text, control, scope);
        return;
      }
      if (ts.isArrayBindingPattern(name)) {
        for (const [index, element] of name.elements.entries()) {
          if (ts.isOmittedExpression(element)) continue;
          const selected =
            typeof control === 'object' && control.kind === 'array'
              ? element.dotDotDotToken
                ? {
                    kind: 'array' as const,
                    elements: control.elements.slice(index),
                  }
                : control.elements[index]
              : undefined;
          assignBindingName(
            element.name,
            selected ??
              (element.initializer
                ? resolveTestControlValue(element.initializer, scope)
                : undefined),
            scope
          );
        }
        return;
      }
      const usedProperties = new Set<string>();
      for (const element of name.elements) {
        if (element.dotDotDotToken) {
          const remaining = new Map<string, TestControlValue>();
          if (typeof control === 'object' && control.kind === 'object') {
            for (const [property, value] of control.properties) {
              if (!usedProperties.has(property)) remaining.set(property, value);
            }
          }
          assignBindingName(
            element.name,
            { kind: 'object', properties: remaining },
            scope
          );
          continue;
        }
        const property = element.propertyName
          ? getPropertyName(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (property) usedProperties.add(property);
        const selected = getPropertyControl(control, property);
        assignBindingName(
          element.name,
          selected ??
            (element.initializer
              ? resolveTestControlValue(element.initializer, scope)
              : undefined),
          scope
        );
      }
    };
    const assignAggregateProperty = (
      expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
      control: TestControlValue | undefined,
      scope: TestControlScope
    ) => {
      const property = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.argumentExpression
          ? getPropertyName(expression.argumentExpression)
          : undefined;
      if (property === undefined) return;

      let target = resolveTestControlValue(expression.expression, scope);
      if (typeof target !== 'object') {
        const index = Number(property);
        target =
          ts.isElementAccessExpression(expression) &&
          Number.isInteger(index) &&
          index >= 0
            ? { kind: 'array', elements: [] }
            : { kind: 'object', properties: new Map() };
        assignExpressionPattern(expression.expression, target, scope);
      }

      if (target.kind === 'union') return;
      if (target.kind === 'array') {
        const index = Number(property);
        if (!Number.isInteger(index) || index < 0) return;
        target.elements[index] = control;
      } else if (control === undefined) {
        target.properties.delete(property);
      } else {
        target.properties.set(property, control);
      }
    };
    const assignExpressionPattern = (
      expression: ts.Expression,
      control: TestControlValue | undefined,
      scope: TestControlScope
    ) => {
      if (ts.isParenthesizedExpression(expression)) {
        assignExpressionPattern(expression.expression, control, scope);
      } else if (ts.isIdentifier(expression)) {
        assignIdentifier(expression.text, control, scope);
      } else if (
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)
      ) {
        assignAggregateProperty(expression, control, scope);
      } else if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        assignExpressionPattern(
          expression.left,
          control ?? resolveTestControlValue(expression.right, scope),
          scope
        );
      } else if (ts.isObjectLiteralExpression(expression)) {
        const usedProperties = new Set<string>();
        for (const property of expression.properties) {
          if (ts.isSpreadAssignment(property)) {
            const remaining = new Map<string, TestControlValue>();
            if (typeof control === 'object' && control.kind === 'object') {
              for (const [name, value] of control.properties) {
                if (!usedProperties.has(name)) remaining.set(name, value);
              }
            }
            assignExpressionPattern(
              property.expression,
              { kind: 'object', properties: remaining },
              scope
            );
          } else if (ts.isShorthandPropertyAssignment(property)) {
            usedProperties.add(property.name.text);
            assignIdentifier(
              property.name.text,
              getPropertyControl(control, property.name.text),
              scope
            );
          } else if (ts.isPropertyAssignment(property)) {
            const propertyName = getPropertyName(property.name);
            if (propertyName) usedProperties.add(propertyName);
            assignExpressionPattern(
              property.initializer,
              getPropertyControl(control, propertyName),
              scope
            );
          }
        }
      } else if (ts.isArrayLiteralExpression(expression)) {
        for (const [index, element] of expression.elements.entries()) {
          if (ts.isOmittedExpression(element)) continue;
          const selected =
            typeof control === 'object' && control.kind === 'array'
              ? control.elements[index]
              : undefined;
          if (ts.isSpreadElement(element)) {
            assignExpressionPattern(
              element.expression,
              typeof control === 'object' && control.kind === 'array'
                ? {
                    kind: 'array',
                    elements: control.elements.slice(index),
                  }
                : undefined,
              scope
            );
          } else {
            assignExpressionPattern(element, selected, scope);
          }
        }
      }
    };
    const analyzeStatements = (
      statements: ts.NodeArray<ts.Statement>,
      scope: TestControlScope
    ) => {
      predeclareStatements(statements, scope);
      for (const statement of statements) analyze(statement, scope);
    };
    const analyzeFunction = (
      node: ts.SignatureDeclaration,
      scope: TestControlScope
    ) => {
      const functionScope = createScope(scope, true);
      if (ts.isFunctionExpression(node) && node.name) {
        functionScope.bindings.set(node.name.text, false);
      }
      for (const parameter of node.parameters) {
        declareBindingName(parameter.name, functionScope);
      }
      for (const parameter of node.parameters) {
        analyze(parameter.name, functionScope);
      }
      for (const parameter of node.parameters) {
        if (!parameter.initializer) continue;
        analyze(parameter.initializer, functionScope);
        assignBindingName(
          parameter.name,
          resolveTestControlValue(parameter.initializer, functionScope),
          functionScope
        );
      }
      const body = (node as ts.FunctionLikeDeclaration).body;
      if (body) {
        predeclareFunctionVariables(body, functionScope);
        if (ts.isBlock(body)) {
          analyzeStatements(body.statements, functionScope);
        } else {
          analyze(body, functionScope);
        }
      }
    };
    const analyze = (node: ts.Node, scope: TestControlScope): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause;
        const frameworkModule = FRAMEWORK_MODULES.has(
          node.moduleSpecifier.text
        );
        if (clause?.name) scope.bindings.set(clause.name.text, false);
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            scope.bindings.set(
              clause.namedBindings.name.text,
              frameworkModule ? 'namespace' : false
            );
          } else {
            for (const element of clause.namedBindings.elements) {
              const imported = element.propertyName?.text ?? element.name.text;
              scope.bindings.set(
                element.name.text,
                frameworkModule ? (getNamedControl(imported) ?? false) : false
              );
            }
          }
        }
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        analyze(node.name, scope);
        if (node.initializer) analyze(node.initializer, scope);
        assignBindingName(
          node.name,
          node.initializer
            ? resolveTestControlValue(node.initializer, scope)
            : KNOWN_NULLISH,
          scope
        );
        return;
      }
      if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          analyze(node.right, scope);
          assignExpressionPattern(
            node.left,
            resolveTestControlValue(node.right, scope),
            scope
          );
          return;
        }
        if (isLogicalAssignmentOperator(node.operatorToken.kind)) {
          const left = resolveTestControlValue(node.left, scope);
          const leftState = getStaticExpressionState(node.left);
          analyze(node.right, scope);
          assignExpressionPattern(
            node.left,
            resolveLogicalAssignmentValue(
              node.operatorToken.kind,
              left,
              resolveTestControlValue(node.right, scope),
              leftState
            ),
            scope
          );
          return;
        }
      }
      if (ts.isCallExpression(node)) {
        const control = resolveTestControl(node.expression, scope);
        if (control === 'focused' || control === 'skipped') {
          reportControl(node, control);
        }
        analyze(node.expression, scope);
        for (const argument of node.arguments) analyze(argument, scope);
        return;
      }
      if (ts.isFunctionLike(node)) {
        analyzeFunction(node, scope);
        return;
      }
      if (ts.isCatchClause(node)) {
        const catchScope = createScope(scope);
        if (node.variableDeclaration) {
          declareBindingName(node.variableDeclaration.name, catchScope);
          assignBindingName(
            node.variableDeclaration.name,
            undefined,
            catchScope
          );
        }
        analyzeStatements(node.block.statements, catchScope);
        return;
      }
      if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node)
      ) {
        const loopScope = createScope(scope);
        const initializer = node.initializer;
        if (
          initializer &&
          ts.isVariableDeclarationList(initializer) &&
          initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
        ) {
          for (const declaration of initializer.declarations) {
            declareBindingName(declaration.name, loopScope);
          }
        }
        if (ts.isForStatement(node)) {
          if (initializer) analyze(initializer, loopScope);
          if (node.condition) analyze(node.condition, loopScope);
          if (node.incrementor) analyze(node.incrementor, loopScope);
        } else {
          const iterationInitializer = node.initializer;
          analyze(node.expression, loopScope);
          if (ts.isVariableDeclarationList(iterationInitializer)) {
            analyze(iterationInitializer, loopScope);
          } else {
            assignExpressionPattern(iterationInitializer, undefined, loopScope);
          }
        }
        analyze(node.statement, loopScope);
        return;
      }
      if (ts.isSwitchStatement(node)) {
        analyze(node.expression, scope);
        const switchScope = createScope(scope);
        const statements = node.caseBlock.clauses.flatMap((clause) => [
          ...clause.statements,
        ]);
        predeclareStatements(
          ts.factory.createNodeArray(statements),
          switchScope
        );
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) analyze(clause.expression, switchScope);
          for (const statement of clause.statements) {
            analyze(statement, switchScope);
          }
        }
        return;
      }
      if (ts.isBlock(node)) {
        analyzeStatements(node.statements, createScope(scope));
        return;
      }
      ts.forEachChild(node, (child) => analyze(child, scope));
    };
    const rootScope = createScope();
    predeclareFunctionVariables(sourceFile, rootScope);
    analyzeStatements(sourceFile.statements, rootScope);
  }
}

export function getDefaultRunRoot() {
  return resolve(
    process.env.OGI_E2E_RUN_ROOT ?? join(tmpdir(), 'ogi-e2e-runs')
  );
}
