import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApplicationRunDescriptor } from './src/application-scenario';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationDirectory = resolve(currentDirectory, '../application');
const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readApplicationRunDescriptor(descriptorPath);
const appArgs = [
  '--disable-gpu',
  // Local E2E only: the unpackaged Electron helper is not installed setuid.
  '--no-sandbox',
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
      'wdio:electronServiceOptions': {
        appEntryPoint: join(applicationDirectory, 'e2e-main.cjs'),
        appArgs,
      },
    },
  ],
  services: [
    [
      'electron',
      {
        appEntryPoint: join(applicationDirectory, 'e2e-main.cjs'),
        appArgs,
      },
    ],
  ],
};
