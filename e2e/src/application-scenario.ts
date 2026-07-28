import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Data } from 'effect';
import sharp from 'sharp';
import { getDefaultRunRoot } from './run-reliability';

export type ApplicationScenarioMode =
  | 'success'
  | 'assertion-failure'
  | 'flaky-once'
  | 'helper-leak';

export type ApplicationRunDescriptor = {
  version: 1;
  scenario: 'application-visible-navigation';
  runId: string;
  mode: ApplicationScenarioMode;
  sandboxDirectory: string;
  applicationStateDirectory: string;
  userDataDirectory: string;
  artifactDirectory: string;
  eventLogPath: string;
};

export class RunDescriptorValidationError extends Data.TaggedError(
  'RunDescriptorValidationError'
)<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

export class FailureEvidenceValidationError extends Data.TaggedError(
  'FailureEvidenceValidationError'
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message() {
    return this.detail;
  }
}

const require = createRequire(import.meta.url);
const { validateApplicationRunDescriptor } =
  require('./application-run-descriptor.cjs') as {
    validateApplicationRunDescriptor(value: unknown): ApplicationRunDescriptor;
  };

export function parseApplicationRunDescriptor(
  value: unknown
): ApplicationRunDescriptor {
  try {
    return validateApplicationRunDescriptor(value);
  } catch (cause) {
    throw new RunDescriptorValidationError({
      detail: (cause as Error).message,
    });
  }
}

export function readApplicationRunDescriptor(path: string) {
  return parseApplicationRunDescriptor(JSON.parse(readFileSync(path, 'utf8')));
}

export function parseApplicationScenarioMode(
  args: readonly string[]
): ApplicationScenarioMode {
  if (args.length === 0) return 'success';
  if (
    args.length === 2 &&
    args[0] === '--mode' &&
    (args[1] === 'success' ||
      args[1] === 'assertion-failure' ||
      args[1] === 'flaky-once' ||
      args[1] === 'helper-leak')
  ) {
    return args[1];
  }
  throw new RunDescriptorValidationError({
    detail:
      'Application Scenario mode must be configured as --mode success, --mode assertion-failure, --mode flaky-once, or --mode helper-leak',
  });
}

async function isValidScreenshot(path: string) {
  const contents = readFileSync(path);
  const pngEnd = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  if (
    contents.length <= pngEnd.length ||
    !contents.subarray(-pngEnd.length).equals(pngEnd)
  ) {
    return false;
  }
  const image = sharp(path);
  const metadata = await image.metadata();
  await image.clone().raw().toBuffer();
  return (
    metadata.format === 'png' &&
    metadata.width !== undefined &&
    metadata.width >= 320 &&
    metadata.height !== undefined &&
    metadata.height >= 180
  );
}

export async function createUnavailableScreenshot(
  path: string,
  detail: string
) {
  const xmlSafeDetail = [...detail]
    .slice(0, 160)
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      const isXmlCharacter =
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      return isXmlCharacter ? character : '\uFFFD';
    })
    .join('');
  const escapedDetail = xmlSafeDetail
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const diagnostic = Buffer.from(`
    <svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="450" fill="#191b22"/>
      <rect x="36" y="36" width="728" height="378" rx="18" fill="#282c36"/>
      <text x="72" y="120" fill="#ff6b6b" font-family="sans-serif" font-size="32">
        Application screenshot unavailable
      </text>
      <text x="72" y="178" fill="#f4f4f5" font-family="sans-serif" font-size="20">
        Failure occurred outside an active browser session.
      </text>
      <text x="72" y="230" fill="#a1a1aa" font-family="monospace" font-size="16">
        ${escapedDetail}
      </text>
      <text x="72" y="354" fill="#a1a1aa" font-family="sans-serif" font-size="16">
        See application-main.log and application-renderer.log for diagnostics.
      </text>
    </svg>
  `);
  await sharp(diagnostic).png().toFile(path);
}

export async function ensureApplicationFailureEvidence(
  descriptor: Pick<
    ApplicationRunDescriptor,
    'artifactDirectory' | 'mode' | 'runId'
  >,
  detail: string
) {
  const screenshotPath = join(descriptor.artifactDirectory, 'failure.png');
  try {
    if (!(await isValidScreenshot(screenshotPath))) {
      await createUnavailableScreenshot(screenshotPath, detail);
    }
  } catch {
    await createUnavailableScreenshot(screenshotPath, detail);
  }
  for (const artifact of [
    'application-main.log',
    'application-renderer.log',
  ] as const) {
    const artifactPath = join(descriptor.artifactDirectory, artifact);
    let contents = Buffer.alloc(0);
    try {
      contents = readFileSync(artifactPath);
    } catch {
      // The runner supplies an explicit diagnostic when product logging failed.
    }
    if (contents.length === 0) {
      writeFileSync(
        artifactPath,
        `Harness diagnostic: ${artifact} was unavailable: ${detail}\n`
      );
    }
  }
  return validateApplicationFailureEvidence(descriptor);
}

export async function validateApplicationFailureEvidence(
  descriptor: Pick<
    ApplicationRunDescriptor,
    'artifactDirectory' | 'mode' | 'runId'
  >
) {
  const expectedLogs = [
    'application-main.log',
    'application-renderer.log',
  ] as const;
  const screenshotPath = join(descriptor.artifactDirectory, 'failure.png');
  try {
    if (!(await isValidScreenshot(screenshotPath))) {
      throw new Error('screenshot is not a usable PNG');
    }
  } catch (cause) {
    throw new FailureEvidenceValidationError({
      detail: 'Required failure evidence is missing or invalid: failure.png',
      cause,
    });
  }
  for (const artifact of expectedLogs) {
    const artifactPath = join(descriptor.artifactDirectory, artifact);
    try {
      const contents = readFileSync(artifactPath);
      if (contents.length === 0) {
        throw new Error('log is empty');
      }
    } catch (cause) {
      throw new FailureEvidenceValidationError({
        detail: `Required failure evidence is missing or invalid: ${artifact}`,
        cause,
      });
    }
  }
  return ['failure.png', ...expectedLogs] as Array<
    'failure.png' | (typeof expectedLogs)[number]
  >;
}

export function validateApplicationScenarioProcessOutcome(
  mode: ApplicationScenarioMode,
  processFailed: boolean
) {
  if (mode === 'assertion-failure' && !processFailed) {
    throw new FailureEvidenceValidationError({
      detail:
        'Deliberate assertion-failure mode unexpectedly exited successfully',
    });
  }
}

export function getApplicationScenarioLaunch(platform: NodeJS.Platform) {
  if (platform === 'linux') {
    return {
      command: 'xvfb-run',
      args: [
        '-a',
        'bunx',
        'wdio',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: true,
    };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        '../updater/src/windows-job-wrapper.ps1',
        'bunx',
        'wdio',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: false,
    };
  }
  return {
    command: 'bunx',
    args: ['wdio', 'run', './application-scenario-wdio.conf.ts'],
    detached: true,
  };
}

export function createApplicationScenarioSandbox(
  runId: string,
  mode: ApplicationScenarioMode = 'success'
) {
  const runRoot = getDefaultRunRoot();
  mkdirSync(runRoot, { recursive: true });
  const sandboxDirectory = mkdtempSync(join(runRoot, `application-${runId}-`));
  const applicationStateDirectory = join(sandboxDirectory, 'application-state');
  const userDataDirectory = join(sandboxDirectory, 'user-data');
  const artifactDirectory = join(sandboxDirectory, 'artifacts');
  const eventLogPath = join(sandboxDirectory, 'events.jsonl');
  const descriptorPath = join(sandboxDirectory, 'run-descriptor.json');
  const optionDirectory = join(applicationStateDirectory, 'config/option');
  const downloadsDirectory = join(sandboxDirectory, 'downloads');
  for (const directory of [
    optionDirectory,
    userDataDirectory,
    artifactDirectory,
    downloadsDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(optionDirectory, 'general.json'),
    JSON.stringify({
      theme: 'light',
      fileDownloadLocation: downloadsDirectory,
      addons: [],
      torrentClient: 'webtorrent',
      marketplaceSources: [],
    })
  );
  writeFileSync(
    join(optionDirectory, 'installed.json'),
    JSON.stringify({ installed: true })
  );
  const descriptor = parseApplicationRunDescriptor({
    version: 1,
    scenario: 'application-visible-navigation',
    runId,
    mode,
    sandboxDirectory,
    applicationStateDirectory,
    userDataDirectory,
    artifactDirectory,
    eventLogPath,
  });
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
  return { ...descriptor, descriptorPath };
}
