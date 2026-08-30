import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';

// Layout mirrors a real Linux install: the updater launches the AppImage with
// cwd = <updater>/update, wipes that directory on every update (keeping only
// artifacts/latest.log/logs), and the OGI data dir lives elsewhere.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-desktop-shortcut-'));
const updateDir = path.join(root, 'updater', 'update');
const homeDir = path.join(root, 'home');
const dataDir = path.join(root, 'data', 'OpenGameInstaller');

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => root,
    getPath: () => root,
  },
}));
// manager.paths caches __dirname at first import, and other test files may
// import it earlier with their own OGI_DIRECTORY — mock it directly instead.
mock.module('@/electron/manager/manager.paths.js', () => ({
  __dirname: dataDir,
  isDev: () => false,
}));
// Bun's os.homedir() ignores $HOME, so redirect it to keep the real
// ~/Desktop untouched.
mock.module('node:os', () => ({ ...os, homedir: () => homeDir }));

let addToDesktop: typeof import('../src/electron/handlers/helpers.app/desktop-shortcut.js').addToDesktop;

const originalCwd = process.cwd();

beforeAll(async () => {
  fs.mkdirSync(updateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // dev-mode source icon resolves to <__dirname>/../../public/favicon.png
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'favicon.png'), 'icon-bytes');
  fs.writeFileSync(
    path.join(updateDir, 'OpenGameInstaller.AppImage'),
    'app-bytes'
  );
  process.chdir(updateDir);
  ({ addToDesktop } = await import(
    '../src/electron/handlers/helpers.app/desktop-shortcut.js'
  ));
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

// Same wipe the updater's prepareUpdateDestination performs before installing
// a new release into update/.
function simulateUpdaterWipe() {
  const preserved = new Set(['artifacts', 'latest.log', 'logs']);
  for (const entry of fs.readdirSync(updateDir)) {
    if (preserved.has(entry)) continue;
    fs.rmSync(path.join(updateDir, entry), { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(updateDir, 'OpenGameInstaller.AppImage'),
    'new-app-bytes'
  );
}

test('desktop shortcut icon survives an updater wipe of update/', async () => {
  const result = await Effect.runPromise(addToDesktop());
  expect(result.success).toBe(true);

  const desktopFile = path.join(
    homeDir,
    'Desktop',
    'OpenGameInstaller.desktop'
  );
  expect(fs.existsSync(desktopFile)).toBe(true);
  const iconLine = fs
    .readFileSync(desktopFile, 'utf-8')
    .split('\n')
    .find((line) => line.startsWith('Icon='));
  expect(iconLine).toBeDefined();
  const iconPath = (iconLine as string).slice('Icon='.length);
  expect(fs.existsSync(iconPath)).toBe(true);

  simulateUpdaterWipe();

  expect(fs.existsSync(iconPath)).toBe(true);
});
