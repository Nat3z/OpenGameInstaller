import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function findUnexpectedFixtureRequests(fixtureRequestLogPath: string) {
  if (!existsSync(fixtureRequestLogPath)) {
    return [
      {
        source: fixtureRequestLogPath,
        unexpected: true,
        error: 'Fixture Service request log missing',
      },
    ];
  }
  return readFileSync(fixtureRequestLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { unexpected?: boolean })
    .filter((entry) => entry.unexpected === true)
    .map((entry) => ({ source: fixtureRequestLogPath, ...entry }));
}

export function findUnexpectedOfflineTraffic(
  trafficLogPaths: readonly string[],
  fixtureRequestLogPath: string
) {
  const unexpectedTraffic = trafficLogPaths.flatMap((path) => {
    if (!existsSync(path)) {
      return [{ source: path, expected: false, error: 'traffic log missing' }];
    }
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { expected?: boolean })
      .filter((entry) => entry.expected !== true)
      .map((entry) => ({ source: path, ...entry }));
  });
  return [
    ...unexpectedTraffic,
    ...findUnexpectedFixtureRequests(fixtureRequestLogPath),
  ];
}

const unexpectedRuntimeErrorPatterns = [
  /UnhandledPromiseRejection/i,
  /Uncaught Exception/i,
  /ERR_UNHANDLED_REJECTION/i,
  /\bFATAL\b/i,
];

export function findUnexpectedRuntimeLogErrors(logPaths: readonly string[]) {
  return logPaths.flatMap((path) => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) =>
        unexpectedRuntimeErrorPatterns.some((pattern) => pattern.test(line))
      )
      .map((line) => ({ path, line }));
  });
}

export type ProductionPackagingBoundary = {
  applicationIncludedPaths: string[];
  updaterIncludedPaths: string[];
  activeHookMatches: string[];
};

export function assertProductionPackagingBoundary(
  boundary: ProductionPackagingBoundary
) {
  if (boundary.activeHookMatches.length > 0) {
    throw new Error(
      `Production packaging contains active E2E hooks: ${boundary.activeHookMatches.join(', ')}`
    );
  }
  return boundary;
}

export const productionForbiddenHookMarkers = [
  'OGI_RUN_DESCRIPTOR',
  'OGI_FIXTURE_',
  'OGI_RECOVERY_STARTUP_HEALTH',
  'OGI_E2E_',
  'nativeDialogResponses',
  'packaged-updater-application-handoff',
  'e2e-product-main.cjs',
  'e2e-product-journey-main.cjs',
  'e2e-scenario-main.cjs',
  'packaged-handoff-run-descriptor.cjs',
] as const;

export function findProductionForbiddenHook(contents: Buffer) {
  return productionForbiddenHookMarkers.find((marker) =>
    contents.includes(Buffer.from(marker))
  );
}

export function verifyProductionPackagingBoundary(repositoryDirectory: string) {
  const applicationPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'application/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const updaterPackage = JSON.parse(
    readFileSync(join(repositoryDirectory, 'updater/package.json'), 'utf8')
  ) as { build?: { files?: string[] } };
  const applicationIncludedPaths = applicationPackage.build?.files ?? [];
  const updaterIncludedPaths = updaterPackage.build?.files ?? [];
  for (const includedPath of [
    ...applicationIncludedPaths,
    ...updaterIncludedPaths,
  ]) {
    if (/e2e|run-descriptor/i.test(includedPath)) {
      throw new Error(
        `Production packaging includes an E2E path: ${includedPath}`
      );
    }
  }

  const activeHookMatches: string[] = [];
  const scan = (root: string) => {
    if (!existsSync(root)) {
      throw new Error(`Production packaging input is missing: ${root}`);
    }
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (entry.name.endsWith('.map')) continue;
        if (findProductionForbiddenHook(readFileSync(path))) {
          activeHookMatches.push(relative(repositoryDirectory, path));
        }
      }
    };
    visit(root);
  };
  scan(join(repositoryDirectory, 'application/out'));
  scan(join(repositoryDirectory, 'updater/dist'));
  return {
    applicationIncludedPaths,
    updaterIncludedPaths,
    activeHookMatches,
  };
}
