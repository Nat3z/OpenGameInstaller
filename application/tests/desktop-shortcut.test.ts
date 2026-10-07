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
// Steam shortcut launches run OGI with cwd set to the game's directory.
const gameDir = path.join(root, 'games', 'SomeGame');
const appImagePath = path.join(updateDir, 'OpenGameInstaller.AppImage');

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
  fs.mkdirSync(gameDir, { recursive: true });
  // dev-mode source icon resolves to <__dirname>/../../public/favicon.png
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'favicon.png'), 'icon-bytes');
  fs.writeFileSync(appImagePath, 'app-bytes');
  process.env.APPIMAGE = appImagePath;
  process.chdir(gameDir);
  ({ addToDesktop } = await import(
    '../src/electron/handlers/helpers.app/desktop-shortcut.js'
  ));
});

afterAll(() => {
  delete process.env.APPIMAGE;
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
  fs.writeFileSync(appImagePath, 'new-app-bytes');
}

const desktopFile = path.join(homeDir, 'Desktop', 'OpenGameInstaller.desktop');

async function writeShortcut(): Promise<string[]> {
  const result = await Effect.runPromise(addToDesktop());
  expect(result.success).toBe(true);
  return fs.readFileSync(desktopFile, 'utf-8').split('\n');
}

test('desktop shortcut targets the AppImage and its icon survives an updater wipe', async () => {
  const lines = await writeShortcut();
  expect(lines).toContain(`Exec=${appImagePath}`);
  expect(lines).toContain(`Path=${updateDir}`);
  const iconLine = lines.find((line) => line.startsWith('Icon='));
  expect(iconLine).toBeDefined();
  const iconPath = (iconLine as string).slice('Icon='.length);
  expect(fs.existsSync(iconPath)).toBe(true);

  simulateUpdaterWipe();

  expect(fs.existsSync(iconPath)).toBe(true);
});

test('desktop shortcut prefers the setup AppImage beside update/', async () => {
  const setupPath = path.join(
    path.dirname(updateDir),
    'OpenGameInstaller-Setup.AppImage'
  );
  fs.writeFileSync(setupPath, 'setup-bytes');
  try {
    const lines = await writeShortcut();
    expect(lines).toContain(`Exec=${setupPath}`);
    expect(lines).toContain(`Path=${path.dirname(updateDir)}`);
  } finally {
    fs.rmSync(setupPath);
  }
});
