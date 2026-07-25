import { join } from 'node:path';
import { readPackagedHandoffRunDescriptor } from './src/packaged-handoff';

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readPackagedHandoffRunDescriptor(descriptorPath);
const appArgs = [
  '--disable-gpu',
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
      'wdio:electronServiceOptions': {
        appEntryPoint: join(
          descriptor.packagedUpdaterDirectory,
          'e2e-product-main.cjs'
        ),
        appArgs,
      },
    },
  ],
  services: [
    [
      'electron',
      {
        appEntryPoint: join(
          descriptor.packagedUpdaterDirectory,
          'e2e-product-main.cjs'
        ),
        appArgs,
      },
    ],
  ],
};
