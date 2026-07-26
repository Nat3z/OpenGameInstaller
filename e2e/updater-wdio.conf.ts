import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronServiceOptions } from './electron-service-options';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const updaterDirectory = resolve(currentDirectory, '../updater');
const sandboxDirectory = process.env.OGI_SCENARIO_SANDBOX;
if (!sandboxDirectory) {
  throw new Error('OGI_SCENARIO_SANDBOX is required');
}
const appArgs = [
  '--disable-gpu',
  '--no-sandbox',
  `--user-data-dir=${join(sandboxDirectory, 'user-data')}`,
];

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./specs/updater.accessibility.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  mochaOpts: {
    timeout: 120_000,
  },
  capabilities: [
    {
      browserName: 'electron',
      'wdio:electronServiceOptions': createElectronServiceOptions(
        join(updaterDirectory, 'e2e-main.cjs'),
        appArgs
      ),
    },
  ],
  services: [
    [
      'electron',
      createElectronServiceOptions(
        join(updaterDirectory, 'e2e-main.cjs'),
        appArgs
      ),
    ],
  ],
};
