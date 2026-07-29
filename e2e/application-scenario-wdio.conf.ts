import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronServiceOptions } from './electron-service-options';
import { readApplicationRunDescriptor } from './src/application-scenario';
import { writeExpectedAssertionExitConfirmation } from './src/run-reliability';

delete process.env.ELECTRON_RUN_AS_NODE;

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationDirectory = resolve(currentDirectory, '../application');
const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readApplicationRunDescriptor(descriptorPath);
const chromedriverBinary = process.env.OGI_CHROMEDRIVER_PATH;
if (!chromedriverBinary) throw new Error('OGI_CHROMEDRIVER_PATH is required');
const appArgs = [
  '--disable-gpu',
  // Local Linux E2E only: the unpackaged Electron helper is not installed setuid.
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  `--user-data-dir=${descriptor.userDataDirectory}`,
];

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./specs/application.visible-navigation.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  mochaOpts: { timeout: 60_000 },
  capabilities: [
    {
      browserName: 'electron',
      'wdio:chromedriverOptions': {
        binary: chromedriverBinary,
      },
      'wdio:electronServiceOptions': createElectronServiceOptions(
        join(applicationDirectory, 'e2e-main.cjs'),
        appArgs
      ),
    },
  ],
  services: [
    [
      'electron',
      createElectronServiceOptions(
        join(applicationDirectory, 'e2e-main.cjs'),
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
