import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const applicationDirectory = resolve(currentDirectory, '../application');
const sandboxDirectory = mkdtempSync(join(tmpdir(), 'ogi-accessibility-'));
const state = process.env.OGI_ACCESSIBILITY_STATE ?? 'welcome';
const optionDirectory = join(sandboxDirectory, 'config/option');

process.env.OGI_DIRECTORY = sandboxDirectory;

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
      'wdio:electronServiceOptions': {
        appEntryPoint: join(applicationDirectory, 'e2e-main.cjs'),
        appArgs: ['--disable-gpu', '--no-sandbox'],
        captureRendererLogs: true,
      },
    },
  ],
  services: [
    [
      'electron',
      {
        appEntryPoint: join(applicationDirectory, 'e2e-main.cjs'),
        appArgs: ['--disable-gpu', '--no-sandbox'],
        captureRendererLogs: true,
      },
    ],
  ],
  onComplete() {
    rmSync(sandboxDirectory, { recursive: true, force: true });
  },
};
