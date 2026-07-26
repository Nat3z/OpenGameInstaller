import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronServiceOptions } from './electron-service-options';
import { writeExpectedAssertionExitConfirmation } from './src/run-reliability';
import { readUpdaterRunDescriptor } from './src/updater-scenario';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const updaterDirectory = resolve(currentDirectory, '../updater');
const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readUpdaterRunDescriptor(descriptorPath);
const appArgs = [
  '--disable-gpu',
  // Local E2E only: the unpackaged Electron helper is not installed setuid.
  '--no-sandbox',
  `--user-data-dir=${descriptor.userDataDirectory}`,
];

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./specs/updater.fixture-release.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  mochaOpts: { timeout: 60_000 },
  capabilities: [
    {
      browserName: 'electron',
      'wdio:electronServiceOptions': createElectronServiceOptions(
        join(updaterDirectory, 'e2e-scenario-main.cjs'),
        appArgs
      ),
    },
  ],
  services: [
    [
      'electron',
      createElectronServiceOptions(
        join(updaterDirectory, 'e2e-scenario-main.cjs'),
        appArgs
      ),
    ],
  ],
  onComplete(
    exitCode: number,
    _config: unknown,
    _capabilities: unknown,
    results: unknown
  ) {
    writeExpectedAssertionExitConfirmation(
      process.env.OGI_EXPECTED_ASSERTION_EXIT,
      exitCode,
      results
    );
  },
};
