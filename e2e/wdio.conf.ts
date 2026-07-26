import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessibilityState } from './accessibility-states';
import { createElectronServiceOptions } from './electron-service-options';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationDirectory = resolve(currentDirectory, '../application');
const state = getAccessibilityState();
const inheritedRunDescriptorPath = process.env.OGI_RUN_DESCRIPTOR;
const inheritedRunDescriptor =
  inheritedRunDescriptorPath && existsSync(inheritedRunDescriptorPath)
    ? JSON.parse(readFileSync(inheritedRunDescriptorPath, 'utf8'))
    : undefined;
const ownsSandbox = inheritedRunDescriptor === undefined;
const sandboxDirectory =
  inheritedRunDescriptor?.sandboxDirectory ??
  mkdtempSync(join(tmpdir(), 'ogi-accessibility-'));
const optionDirectory = join(sandboxDirectory, 'config/option');
const runDescriptorPath = join(sandboxDirectory, 'run-descriptor.json');
const axeDestination = join(applicationDirectory, 'out/renderer/axe.min.js');

process.env.OGI_DIRECTORY = sandboxDirectory;
process.env.OGI_RUN_DESCRIPTOR = runDescriptorPath;
writeFileSync(
  runDescriptorPath,
  JSON.stringify({
    version: 1,
    scenario: 'application-accessibility',
    state,
    sandboxDirectory,
  })
);
copyFileSync(
  resolve(currentDirectory, '../node_modules/axe-core/axe.min.js'),
  axeDestination
);

if (state === 'oobe-resume' || state === 'main') {
  mkdirSync(optionDirectory, { recursive: true });
}

if (state === 'oobe-resume') {
  writeFileSync(
    join(optionDirectory, 'installed.json'),
    JSON.stringify({ restartRequired: true, installed: false })
  );
}

if (state === 'main') {
  writeFileSync(
    join(optionDirectory, 'general.json'),
    JSON.stringify({
      theme: 'light',
      fileDownloadLocation: sandboxDirectory,
      addons: [],
      torrentClient: 'webtorrent',
      marketplaceSources: [],
    })
  );
  writeFileSync(
    join(optionDirectory, 'installed.json'),
    JSON.stringify({ installed: true })
  );
}

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./specs/application.accessibility.ts'],
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
        join(applicationDirectory, 'e2e-main.cjs'),
        ['--disable-gpu', '--no-sandbox']
      ),
    },
  ],
  services: [
    [
      'electron',
      createElectronServiceOptions(join(applicationDirectory, 'e2e-main.cjs'), [
        '--disable-gpu',
        '--no-sandbox',
      ]),
    ],
  ],
  onComplete() {
    if (ownsSandbox) {
      rmSync(sandboxDirectory, { recursive: true, force: true });
      rmSync(axeDestination, { force: true });
    }
  },
};
