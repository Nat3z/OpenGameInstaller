import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeRunEventWriter,
  readRunEvents,
  renderRunHtmlReport,
} from '../src/run-events';
import {
  applyRunRetention,
  classifyAttemptProcessFailure,
  classifyRunOutcome,
  finalizeRunRetention,
  getRequiredCheckResult,
  hasExpectedAssertionExitConfirmation,
  pinRetainedRun,
  readReliableAttemptEvidenceSummary,
  recordReliableAttemptEvidence,
  resolveOfflineChromedriverPath,
  validateScenarioDisposition,
  validateScenarioSourceDispositions,
  writeExpectedAssertionExitConfirmation,
} from '../src/run-reliability';

const makeRoot = () => mkdtempSync(join(tmpdir(), 'ogi-reliability-test-'));

test('adopts every torrent assertion into top-level evidence with attempt links', () => {
  const aggregateDirectory = makeRoot();
  const attemptDirectory = join(aggregateDirectory, 'attempt-2');
  const artifactDirectory = join(attemptDirectory, 'artifacts');
  mkdirSync(artifactDirectory, { recursive: true });
  const assertionNames = [
    'torrent-network-containment-assertion.json',
    'torrent-network-isolation-assertion.json',
    'torrent-payload-manifest-assertion.json',
  ];
  const evidencePaths = assertionNames.map((name) => {
    const path = join(artifactDirectory, name);
    writeFileSync(path, '{}');
    return path;
  });
  const eventPath = join(aggregateDirectory, 'events.jsonl');
  const writeEvent = makeRunEventWriter(eventPath, 'aggregate-run');
  writeEvent({
    type: 'scenario.started',
    payload: { scenarioId: 'golden-journey', kind: 'Product Journey' },
  });

  recordReliableAttemptEvidence({
    aggregateDirectory,
    attemptDirectory,
    attempt: 2,
    evidencePaths,
    writeEvent,
  });

  const artifactEvents = readRunEvents(eventPath).filter(
    (event) => event.type === 'artifact.created'
  );
  expect(
    artifactEvents.map((event) =>
      event.type === 'artifact.created'
        ? {
            artifactType: event.payload.artifactType,
            path: event.payload.path,
            attempt: event.payload.attempt,
          }
        : null
    )
  ).toEqual([
    {
      artifactType: 'torrent-network-containment-assertion',
      path: 'attempt-2/artifacts/torrent-network-containment-assertion.json',
      attempt: 2,
    },
    {
      artifactType: 'torrent-network-isolation-assertion',
      path: 'attempt-2/artifacts/torrent-network-isolation-assertion.json',
      attempt: 2,
    },
    {
      artifactType: 'torrent-payload-manifest-assertion',
      path: 'attempt-2/artifacts/torrent-payload-manifest-assertion.json',
      attempt: 2,
    },
  ]);
  expect(readReliableAttemptEvidenceSummary(eventPath)).toEqual([
    {
      attempt: 2,
      artifactType: 'torrent-network-containment-assertion',
      path: 'attempt-2/artifacts/torrent-network-containment-assertion.json',
    },
    {
      attempt: 2,
      artifactType: 'torrent-network-isolation-assertion',
      path: 'attempt-2/artifacts/torrent-network-isolation-assertion.json',
    },
    {
      attempt: 2,
      artifactType: 'torrent-payload-manifest-assertion',
      path: 'attempt-2/artifacts/torrent-payload-manifest-assertion.json',
    },
  ]);
  const html = renderRunHtmlReport(eventPath, 'Passed');
  for (const name of assertionNames) {
    expect(html).toContain(`href="attempt-2/artifacts/${name}"`);
  }
  expect(html).toContain('Attempt 2');
});

test('resolves an explicitly pinned or cached Chromedriver without network access', () => {
  const root = makeRoot();
  const explicitPath = join(root, 'explicit-chromedriver');
  writeFileSync(explicitPath, 'driver');
  expect(
    resolveOfflineChromedriverPath({
      environment: {
        OGI_CHROMEDRIVER_PATH: explicitPath,
      },
      platform: 'linux',
    })
  ).toBe(explicitPath);

  const cachedPath = join(
    root,
    'chromedriver',
    'linux-144.0.7559.133',
    'chromedriver-linux64',
    'chromedriver'
  );
  const mismatchedPath = join(
    root,
    'chromedriver',
    'linux-150.0.7871.47',
    'chromedriver-linux64',
    'chromedriver'
  );
  mkdirSync(join(cachedPath, '..'), { recursive: true });
  mkdirSync(join(mismatchedPath, '..'), { recursive: true });
  writeFileSync(cachedPath, 'driver');
  writeFileSync(mismatchedPath, 'driver');
  expect(
    resolveOfflineChromedriverPath({
      environment: { XDG_CACHE_HOME: root },
      platform: 'linux',
      browserMajor: '144',
    })
  ).toBe(cachedPath);
});

function makeRun(
  root: string,
  name: string,
  createdAt: string,
  outcome: Parameters<typeof finalizeRunRetention>[0]['outcome'],
  pinned = false
) {
  const sandboxDirectory = join(root, name);
  mkdirSync(join(sandboxDirectory, 'artifacts'), { recursive: true });
  writeFileSync(join(sandboxDirectory, 'events.jsonl'), '{}\n');
  writeFileSync(join(sandboxDirectory, 'artifacts', 'execution.webm'), 'video');
  finalizeRunRetention({
    runId: name,
    sandboxDirectory,
    outcome,
    createdAt,
    pinned,
    videoPaths: [join(sandboxDirectory, 'artifacts', 'execution.webm')],
  });
  return sandboxDirectory;
}

describe('run reliability policy', () => {
  test('one failed attempt followed by one passed retry is Flaky and fails required checks', () => {
    expect(classifyRunOutcome(['Failed', 'Passed'])).toBe('Flaky');
    expect(classifyRunOutcome(['Passed'])).toBe('Passed');
    expect(getRequiredCheckResult('Passed')).toEqual({
      passed: true,
      exitCode: 0,
    });
    expect(getRequiredCheckResult('Flaky')).toEqual({
      passed: false,
      exitCode: 1,
    });
  });

  test('keeps cancellation, abort, assertion failure, and infrastructure failure distinct', () => {
    expect(classifyRunOutcome(['Cancelled'])).toBe('Cancelled');
    expect(classifyRunOutcome(['Cancelled', 'Passed'])).toBe('Cancelled');
    expect(classifyRunOutcome(['Aborted'])).toBe('Aborted');
    expect(classifyRunOutcome(['Failed'])).toBe('Failed');
    expect(classifyRunOutcome(['Infrastructure Failed'])).toBe(
      'Infrastructure Failed'
    );
  });

  test('structural failures require explicit expected-assertion-exit evidence', () => {
    const statusOneExit = {
      _tag: 'ApplicationScenarioProcessExitError',
      status: 1,
      signal: null,
    };
    expect(classifyAttemptProcessFailure(statusOneExit, false)).toBe(
      'Infrastructure Failed'
    );
    expect(classifyAttemptProcessFailure(statusOneExit, true)).toBe('Failed');
    expect(
      classifyAttemptProcessFailure(
        { _tag: 'ApplicationScenarioTimeoutError' },
        true
      )
    ).toBe('Infrastructure Failed');
    expect(
      classifyAttemptProcessFailure(
        {
          _tag: 'UpdaterScenarioProcessExitError',
          status: null,
          signal: 'SIGKILL',
        },
        true
      )
    ).toBe('Infrastructure Failed');
    expect(
      classifyAttemptProcessFailure(
        { _tag: 'ProductJourneyFixtureError' },
        true
      )
    ).toBe('Infrastructure Failed');
  });

  test('confirms only an orderly single assertion failure completion', () => {
    const root = makeRoot();
    const evidencePath = join(root, 'expected-assertion-exit.json');

    writeExpectedAssertionExitConfirmation(evidencePath, 1, { failed: 1 });
    expect(hasExpectedAssertionExitConfirmation(evidencePath)).toBe(true);

    writeExpectedAssertionExitConfirmation(evidencePath, 1, { failed: 2 });
    expect(hasExpectedAssertionExitConfirmation(evidencePath)).toBe(false);

    writeExpectedAssertionExitConfirmation(evidencePath, 2, { failed: 1 });
    expect(hasExpectedAssertionExitConfirmation(evidencePath)).toBe(false);
  });

  test('deletes passed sandboxes and passed video but retains failure-class evidence', () => {
    const root = makeRoot();
    const passed = makeRun(
      root,
      'passed',
      '2026-07-25T00:00:00.000Z',
      'Passed'
    );
    const flaky = makeRun(root, 'flaky', '2026-07-25T00:00:01.000Z', 'Flaky');
    const cancelled = makeRun(
      root,
      'cancelled',
      '2026-07-25T00:00:02.000Z',
      'Cancelled'
    );
    const pinnedPassed = makeRun(
      root,
      'pinned-passed',
      '2026-07-25T00:00:03.000Z',
      'Passed',
      true
    );

    expect(existsSync(passed)).toBe(false);
    expect(existsSync(join(flaky, 'artifacts', 'execution.webm'))).toBe(true);
    expect(existsSync(join(cancelled, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(pinnedPassed, 'events.jsonl'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(flaky, 'retention.json'), 'utf8'))
    ).toMatchObject({ outcome: 'Flaky', pinned: false });
  });

  test('keeps the newest 20 and every run from the last 14 days, deleting only runs outside both sets', () => {
    const root = makeRoot();
    const now = new Date('2026-07-25T12:00:00.000Z');
    const runs: string[] = [];
    for (let index = 0; index < 25; index++) {
      const ageDays = 30 - index;
      runs.push(
        makeRun(
          root,
          `run-${String(index).padStart(2, '0')}`,
          new Date(now.getTime() - ageDays * 86_400_000).toISOString(),
          'Failed'
        )
      );
    }
    const recentButNotNewest = makeRun(
      root,
      'recent-extra',
      new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      'Aborted'
    );

    const result = applyRunRetention(root, now);
    expect(result.deleted.length).toBeGreaterThan(0);
    expect(existsSync(runs[0]!)).toBe(false);
    expect(existsSync(runs.at(-1)!)).toBe(true);
    expect(existsSync(recentButNotNewest)).toBe(true);
    expect(result.kept.length).toBeGreaterThanOrEqual(20);
  });

  test('prunes old unrecognized crash directories with zero retention', () => {
    const root = makeRoot();
    const orphan = join(root, 'crash-before-events');
    const active = join(root, 'active-startup');
    const pinnedMalformed = join(root, 'pinned-malformed');
    mkdirSync(orphan);
    mkdirSync(active);
    mkdirSync(pinnedMalformed);
    writeFileSync(join(orphan, 'partial.log'), 'crashed');
    writeFileSync(join(pinnedMalformed, 'retention.json'), '{"pinned":true}');
    const old = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(orphan, old, old);
    utimesSync(pinnedMalformed, old, old);
    const now = new Date();

    const result = applyRunRetention(root, now, 0, 0);

    expect(result.deleted).toContain(orphan);
    expect(existsSync(orphan)).toBe(false);
    expect(result.kept).toContain(active);
    expect(result.kept).toContain(pinnedMalformed);
  });

  test('discovers an unterminated event log as Aborted without rewriting it', () => {
    const root = makeRoot();
    const sandbox = join(root, 'aborted');
    mkdirSync(sandbox);
    const eventLogPath = join(sandbox, 'events.jsonl');
    const contents = `${JSON.stringify({
      version: 1,
      runId: 'aborted-run',
      sequence: 1,
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'run.started',
      payload: { platform: 'linux' },
    })}\n`;
    writeFileSync(eventLogPath, contents);

    const result = applyRunRetention(
      root,
      new Date('2026-07-25T12:00:00.000Z')
    );
    expect(result.kept).toContain(sandbox);
    expect(readFileSync(eventLogPath, 'utf8')).toBe(contents);
    expect(
      JSON.parse(readFileSync(join(sandbox, 'retention.json'), 'utf8'))
    ).toMatchObject({ runId: 'aborted-run', outcome: 'Aborted' });
  });

  test('pinning exempts an old run from retention deletion', () => {
    const root = makeRoot();
    const pinned = makeRun(
      root,
      'pinned',
      '2025-01-01T00:00:00.000Z',
      'Failed'
    );
    pinRetainedRun(pinned, true);
    for (let index = 0; index < 21; index++) {
      makeRun(
        root,
        `new-${index}`,
        new Date(Date.UTC(2026, 6, 25, 0, index)).toISOString(),
        'Failed'
      );
    }

    applyRunRetention(root, new Date('2026-07-25T12:00:00.000Z'));
    expect(existsSync(pinned)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(pinned, 'retention.json'), 'utf8')).pinned
    ).toBe(true);
  });

  test('requires complete non-expired quarantine metadata and rejects untracked skips', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    expect(() =>
      validateScenarioDisposition({ scenarioId: 'smoke', skip: true }, now)
    ).toThrow('Untracked skip');
    expect(() =>
      validateScenarioDisposition(
        {
          scenarioId: 'smoke',
          skip: true,
          quarantine: {
            issue: 'todo',
            owner: 'maintainer',
            expires: '2026-08-01',
          },
        },
        now
      )
    ).toThrow('linked issue');
    expect(() =>
      validateScenarioDisposition(
        {
          scenarioId: 'smoke',
          skip: true,
          quarantine: {
            issue: 'issues/123',
            owner: 'maintainer',
            expires: '2026-07-24',
          },
        },
        now
      )
    ).toThrow('expired');
    expect(
      validateScenarioDisposition(
        {
          scenarioId: 'smoke',
          skip: true,
          quarantine: {
            issue: 'issues/123',
            owner: 'maintainer',
            expires: '2026-08-01',
          },
        },
        now
      )
    ).toEqual({ outcome: 'Skipped', quarantined: true });
  });

  test('enforces quarantine metadata and focused-test rejection during source discovery', () => {
    const root = makeRoot();
    const sourcePath = join(root, 'scenario.test.ts');
    const now = new Date('2026-07-25T12:00:00.000Z');

    writeFileSync(sourcePath, "test.skip('untracked', () => {});\n");
    expect(() => validateScenarioSourceDispositions([sourcePath], now)).toThrow(
      'Untracked skip'
    );

    writeFileSync(sourcePath, "test.only('focused', () => {});\n");
    expect(() => validateScenarioSourceDispositions([sourcePath], now)).toThrow(
      'Focused test selection is prohibited'
    );

    writeFileSync(
      sourcePath,
      "// @quarantine issue=issues/123 owner=e2e-maintainer expires=2026-07-24\ntest.skip('expired', () => {});\n"
    );
    expect(() => validateScenarioSourceDispositions([sourcePath], now)).toThrow(
      'expired'
    );

    writeFileSync(
      sourcePath,
      "// @quarantine issue=issues/123 owner=e2e-maintainer expires=2026-08-01\ntest.skip('tracked', () => {});\ntest.skipIf(process.platform === 'win32')('platform gate', () => {});\n"
    );
    expect(() =>
      validateScenarioSourceDispositions([sourcePath], now)
    ).not.toThrow();
  });

  test.each([
    "test\n  .skip\n  .each([[1]])('multiline', () => {});",
    "test.skip.each([[1]])('skip each', () => {});",
    "describe['skip']('computed skip', () => {});",
    "xit('xit alias', () => {});",
    "xdescribe('xdescribe alias', () => {});",
    "xtest('xtest alias', () => {});",
    "test.todo('todo test');",
    "const skipped = test.skip; skipped('aliased skip', () => {});",
    "const { skip: skipped } = describe; skipped('destructured skip', () => {});",
    "let skipped; skipped = it['skip']; skipped('reassigned skip', () => {});",
    "const scenario = test; const skipped = scenario.skip; skipped('reference alias', () => {});",
    "const [skipped] = [test.skip]; skipped('array declaration', () => {});",
    "let skipped; [skipped] = [test.skip]; skipped('array assignment', () => {});",
    "const { x: [skipped] } = { x: [test.skip] }; skipped('nested aggregate', () => {});",
    "const [, skipped = test.skip] = [undefined]; skipped('array hole and default', () => {});",
    "const [...controls] = [test.skip]; controls[0]('array rest', () => {});",
    "const [skipped] = [...[test.skip]]; skipped('array spread', () => {});",
    "const source = { skip: test.skip }; const { ...controls } = source; controls.skip('object rest', () => {});",
    "const controls = {}; controls.skipped = test.skip; controls.skipped('property assignment', () => {});",
    "const controls = []; controls[0] = test.skip; controls[0]('element assignment', () => {});",
    "const holder = { nested: {} }; holder.nested.skipped = test.skip; holder.nested.skipped('nested property assignment', () => {});",
    "const holder = { nested: [] }; holder.nested[0] = test.skip; holder.nested[0]('nested element assignment', () => {});",
    "let controls = {}; ({ ...controls } = { skip: test.skip }); controls.skip('object rest assignment', () => {});",
    "let controls; ({ nested: { ...controls } } = { nested: { skip: test.skip } }); controls.skip('nested object rest assignment', () => {});",
    "(true ? test.skip : test)('conditional skip', () => {});",
    "(condition ? test : test.skip)('reachable conditional skip', () => {});",
    "(test && test.skip)('logical and skip', () => {});",
    "(unknown || test.skip)('logical or skip', () => {});",
    "((undefined ?? test.skip))('nullish skip', () => {});",
    "let selected; selected ??= test.skip; selected('nullish assignment skip', () => {});",
    "let selected; selected ||= test.skip; selected('or assignment skip', () => {});",
    "let selected = test; selected &&= test.skip; selected('and assignment skip', () => {});",
    "const controls = {}; controls.selected ??= test.skip; controls.selected('property logical assignment skip', () => {});",
    "const controls = []; controls[0] ||= test.skip; controls[0]('element logical assignment skip', () => {});",
    "const holder = { nested: { selected: test } }; holder.nested.selected &&= test.skip; holder.nested.selected('nested logical assignment skip', () => {});",
  ])('rejects skip syntax bypass: %s', (source) => {
    const root = makeRoot();
    const sourcePath = join(root, 'skip-bypass.test.ts');
    writeFileSync(sourcePath, `${source}\n`);
    expect(() => validateScenarioSourceDispositions([sourcePath])).toThrow(
      'Untracked skip'
    );
  });

  test.each([
    "test\n  .only('multiline focus', () => {});",
    "test.only.each([[1]])('focused each', () => {});",
    "describe['only']('computed focus', () => {});",
    "fit('fit alias', () => {});",
    "fdescribe('fdescribe alias', () => {});",
    "ftest('ftest alias', () => {});",
    "const focused = test.only; focused('aliased focus', () => {});",
    "const { only: focused } = describe; focused('destructured focus', () => {});",
    "let focused; focused = it.only; focused('reassigned focus', () => {});",
    "const scenario = test; const focused = scenario['only']; focused('reference alias', () => {});",
    "import { test as scenario } from 'bun:test'; scenario.only('import alias', () => {});",
    "import * as suite from 'bun:test'; suite.test.only('namespace import', () => {});",
    "let focused; ({ only: focused } = test); focused('destructuring assignment', () => {});",
    "{ const test = { only() {} }; test.only(); } test.only('real focus after block shadow', () => {});",
    "const [focused] = [test.only]; focused('array declaration', () => {});",
    "let focused; [focused] = [test.only]; focused('array assignment', () => {});",
    "const { x: [focused] } = { x: [test.only] }; focused('nested aggregate', () => {});",
    "const [, focused = test.only] = [undefined]; focused('array hole and default', () => {});",
    "const [...controls] = [test.only]; controls[0]('array rest', () => {});",
    "const [focused] = [...[test.only]]; focused('array spread', () => {});",
    "const source = { only: test.only }; const { ...controls } = source; controls.only('object rest', () => {});",
    "const controls = {}; controls.focused = test.only; controls.focused('property assignment', () => {});",
    "const controls = []; controls[0] = test.only; controls[0]('element assignment', () => {});",
    "const holder = { nested: {} }; holder.nested.focused = test.only; holder.nested.focused('nested property assignment', () => {});",
    "const holder = { nested: [] }; holder.nested[0] = test.only; holder.nested[0]('nested element assignment', () => {});",
    "let controls = {}; ({ ...controls } = { only: test.only }); controls.only('object rest assignment', () => {});",
    "let controls; ({ nested: { ...controls } } = { nested: { only: test.only } }); controls.only('nested object rest assignment', () => {});",
    "(true ? test.only : test)('conditional focus', () => {});",
    "(condition ? test : test.only)('reachable conditional focus', () => {});",
    "(test && test.only)('logical and focus', () => {});",
    "(unknown || test.only)('logical or focus', () => {});",
    "((undefined ?? test.only))('nullish focus', () => {});",
    "let selected; selected ??= test.only; selected('nullish assignment focus', () => {});",
    "let selected; selected ||= test.only; selected('or assignment focus', () => {});",
    "let selected = test; selected &&= test.only; selected('and assignment focus', () => {});",
    "const controls = {}; controls.selected ??= test.only; controls.selected('property logical assignment focus', () => {});",
    "const controls = []; controls[0] ||= test.only; controls[0]('element logical assignment focus', () => {});",
    "const holder = { nested: { selected: test } }; holder.nested.selected &&= test.only; holder.nested.selected('nested logical assignment focus', () => {});",
  ])('rejects focused syntax bypass: %s', (source) => {
    const root = makeRoot();
    const sourcePath = join(root, 'focus-bypass.test.ts');
    writeFileSync(sourcePath, `${source}\n`);
    expect(() => validateScenarioSourceDispositions([sourcePath])).toThrow(
      'Focused test selection is prohibited'
    );
  });

  test('does not flag unrelated only/skip properties or shadowed framework names', () => {
    const root = makeRoot();
    const sourcePath = join(root, 'unrelated-controls.test.ts');
    writeFileSync(
      sourcePath,
      `const utility = { only() {}, skip() {} };
const selected = utility.only;
selected();
utility.skip();
function local(test: { only(): void }) { test.only(); }
const [arraySelected] = [utility.only];
arraySelected();
const { nested: [nestedSelected] } = { nested: [utility.skip] };
nestedSelected();
const propertyControls = {};
propertyControls.selected = utility.only;
propertyControls.selected();
const elementControls = [];
elementControls[0] = utility.skip;
elementControls[0]();
let restControls;
({ ...restControls } = { selected: utility.only });
restControls.selected();
(condition ? utility.only : utility.skip)();
(utility.only || utility.skip)();
(utility.only && utility.skip)();
(utility.only ?? utility.skip)();
(true ? utility.only : test.only)();
(true || test.only)();
(false && test.skip)();
('known' ?? test.only)();
let nullishUnreachable = test;
nullishUnreachable ??= test.only;
nullishUnreachable();
let orUnreachable = test;
orUnreachable ||= test.only;
orUnreachable();
let andUnreachable = false;
andUnreachable &&= test.skip;
const utilityAssignment = utility.only;
let selectedUtility = utilityAssignment;
selectedUtility ||= test.only;
selectedUtility();
const nestedUnreachable = { selected: test };
nestedUnreachable.selected ||= test.only;
nestedUnreachable.selected();
hoistedHelper ||= test.skip;
hoistedHelper();
function hoistedHelper() {}
function nullishHelper() {}
nullishHelper ??= test.only;
{
  blockHelper ||= test.skip;
  function blockHelper() {}
}
function outerHelper() {
  nestedHelper ??= test.only;
  function nestedHelper() {}
}
function overloadedHelper(): void;
function overloadedHelper(): void {}
overloadedHelper ||= test.skip;
declare function declaredHelper(): void;
declaredHelper ??= test.only;
const namedHelper = function utilityName() {};
namedHelper ||= test.skip;
`
    );
    const importedHelperPath = join(root, 'imported-helper.test.ts');
    writeFileSync(
      importedHelperPath,
      "import { test } from './helper'; test.only();\n"
    );
    const importedNamespacePath = join(root, 'imported-namespace.test.ts');
    writeFileSync(
      importedNamespacePath,
      "import * as suite from './helper'; suite.test.only();\n"
    );
    const localFunctionPath = join(root, 'local-function.test.ts');
    writeFileSync(localFunctionPath, 'test.only(); function test() {}\n');
    expect(() =>
      validateScenarioSourceDispositions([
        sourcePath,
        importedHelperPath,
        importedNamespacePath,
        localFunctionPath,
      ])
    ).not.toThrow();
  });

  test.each([
    [
      "const focused = test.only; focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const { skip: skipped } = test; skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "import * as suite from 'bun:test'; suite.test.only('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "let focused; ({ only: focused } = test); focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "{ const test = { only() {} }; test.only(); } test.only('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const [focused] = [test.only]; focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "let focused; [focused] = [test.only]; focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const { x: [focused] } = { x: [test.only] }; focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const [skipped] = [test.skip]; skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "let skipped; [skipped] = [test.skip]; skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const { x: [skipped] } = { x: [test.skip] }; skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const controls = {}; controls.focused = test.only; controls.focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const controls = []; controls[0] = test.only; controls[0]('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const holder = { nested: {} }; holder.nested.focused = test.only; holder.nested.focused('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const holder = { nested: [] }; holder.nested[0] = test.only; holder.nested[0]('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "let controls = {}; ({ ...controls } = { only: test.only }); controls.only('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "let controls; ({ nested: { ...controls } } = { nested: { only: test.only } }); controls.only('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const controls = {}; controls.skipped = test.skip; controls.skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const controls = []; controls[0] = test.skip; controls[0]('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const holder = { nested: {} }; holder.nested.skipped = test.skip; holder.nested.skipped('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const holder = { nested: [] }; holder.nested[0] = test.skip; holder.nested[0]('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "let controls = {}; ({ ...controls } = { skip: test.skip }); controls.skip('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "let controls; ({ nested: { ...controls } } = { nested: { skip: test.skip } }); controls.skip('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "(true ? test.only : test)('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    ["(condition ? test : test.skip)('bypass', () => {});", 'Untracked skip'],
    [
      "(unknown || test.only)('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    ["((undefined ?? test.skip))('bypass', () => {});", 'Untracked skip'],
    [
      "let selected; selected ??= test.skip; selected('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "let selected; selected ||= test.only; selected('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "let selected = test; selected &&= test.skip; selected('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const controls = {}; controls.selected ??= test.only; controls.selected('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "const controls = []; controls[0] ||= test.skip; controls[0]('bypass', () => {});",
      'Untracked skip',
    ],
    [
      "const holder = { nested: { selected: test } }; holder.nested.selected &&= test.only; holder.nested.selected('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "function selected() {} selected &&= test.only; selected('bypass', () => {});",
      'Focused test selection is prohibited',
    ],
    [
      "function selected() {} selected = test.skip; selected ||= test.only; selected('bypass', () => {});",
      'Untracked skip',
    ],
  ])('rejects an aliased control before Product Journey sandbox creation or process spawn', (source, expectedError) => {
    const root = makeRoot();
    const sourcePath = join(root, 'invalid-alias.test.ts');
    const runnerPath = join(root, 'attempt-runner.ts');
    const spawnMarkerPath = join(root, 'attempt-runner-started');
    writeFileSync(sourcePath, `${source}\n`);
    writeFileSync(
      runnerPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'started');`
    );

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_E2E_SCENARIO_SOURCE_PATH: sourcePath,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
        },
        encoding: 'utf8',
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('product-journey-reliable-')
      )
    ).toBe(false);
  });

  test('allows unreachable logical assignments before Product Journey worker execution', () => {
    const root = makeRoot();
    const sourcePath = join(root, 'unreachable-logical-assignments.test.ts');
    const runnerPath = join(root, 'attempt-runner.ts');
    const spawnMarkerPath = join(root, 'attempt-runner-started');
    writeFileSync(
      sourcePath,
      `let selected = test;
selected ??= test.only;
selected ||= test.only;
let skipped = false;
skipped &&= test.skip;
const controls = { selected: test };
controls.selected ||= test.only;
hoisted ||= test.skip;
function hoisted() {}
function nullish() {}
nullish ??= test.only;
{
  blockScoped ||= test.skip;
  function blockScoped() {}
}
function outer() {
  nested ||= test.only;
  function nested() {}
}
function overloaded(): void;
function overloaded(): void {}
overloaded ||= test.skip;
declare function declared(): void;
declared ??= test.only;
const named = function utilityName() {};
named ||= test.skip;
`
    );
    writeFileSync(
      runnerPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'started');`
    );

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_E2E_SCENARIO_SOURCE_PATH: sourcePath,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
        },
        encoding: 'utf8',
      }
    );

    expect(result.stderr).not.toContain('Focused test selection is prohibited');
    expect(result.stderr).not.toContain('Untracked skip');
    expect(existsSync(spawnMarkerPath)).toBe(true);
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('product-journey-reliable-')
      )
    ).toBe(true);
  });

  test('rejects an untracked skip before Product Journey sandbox creation or process spawn', () => {
    const root = makeRoot();
    const sourcePath = join(root, 'invalid-scenario.test.ts');
    const runnerPath = join(root, 'attempt-runner.ts');
    const spawnMarkerPath = join(root, 'attempt-runner-started');
    writeFileSync(sourcePath, "test.skip('untracked', () => {});\n");
    writeFileSync(
      runnerPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'started');`
    );

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, '../src/run-reliable-packaged-handoff.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_E2E_SCENARIO_SOURCE_PATH: sourcePath,
          OGI_PACKAGED_ATTEMPT_RUNNER: runnerPath,
        },
        encoding: 'utf8',
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Untracked skip');
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('product-journey-reliable-')
      )
    ).toBe(false);
  });

  test.each([
    'application',
    'updater',
    'game',
    'helper',
  ])('a surviving %s process is an infrastructure failure', (kind) => {
    expect(
      classifyRunOutcome(['Passed'], {
        leaks: [{ pid: 1234, name: `${kind} fixture` }],
      })
    ).toBe('Infrastructure Failed');
  });
});
