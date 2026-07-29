import { join } from 'node:path';
import { createElectronServiceOptions } from './electron-service-options';
import { readPackagedHandoffRunDescriptor } from './src/packaged-handoff';
import { writeExpectedAssertionExitConfirmation } from './src/run-reliability';

delete process.env.ELECTRON_RUN_AS_NODE;

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readPackagedHandoffRunDescriptor(descriptorPath);
const chromedriverBinary = process.env.OGI_CHROMEDRIVER_PATH;
const appArgs = [
  '--disable-gpu',
  ...(descriptor.offlineProductBehavior ? ['--online=false'] : []),
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  `--user-data-dir=${descriptor.updaterUserDataDirectory}`,
];

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./specs/packaged-handoff.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 30_000,
  connectionRetryTimeout: 300_000,
  mochaOpts: { timeout: 300_000 },
  capabilities: [
    {
      browserName: 'electron',
      ...(chromedriverBinary
        ? {
            'wdio:chromedriverOptions': {
              binary: chromedriverBinary,
            },
          }
        : {}),
      'wdio:electronServiceOptions': createElectronServiceOptions(
        join(descriptor.packagedUpdaterDirectory, 'e2e-product-main.cjs'),
        appArgs
      ),
    },
  ],
  services: [
    [
      'electron',
      createElectronServiceOptions(
        join(descriptor.packagedUpdaterDirectory, 'e2e-product-main.cjs'),
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
