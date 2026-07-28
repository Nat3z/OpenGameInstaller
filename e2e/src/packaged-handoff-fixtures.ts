import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { blake2b } from 'blakejs';

export type PackagedHandoffPlatform = 'linux' | 'win32';

const fixtureGameLine =
  'OpenGameInstaller interrupted download recovery fixture bytes\n';
export const FIXTURE_GAME_CONTENT = Buffer.from(
  fixtureGameLine.repeat(
    Math.ceil((256 * 1024) / Buffer.byteLength(fixtureGameLine))
  )
).subarray(0, 256 * 1024);
export const FIXTURE_GAME_TERMINATION_BYTES = 64 * 1024;
export const FIXTURE_GAME_MAIN = `const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const markerArgument = process.argv.find((argument) => argument.startsWith('--marker='));
if (!markerArgument) throw new Error('Fixture game marker path is required');
const markerPath = markerArgument.slice('--marker='.length);
ipcMain.handle('fixture-game:close', () => app.quit());
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: false,
    title: 'OpenGameInstaller Fixture Game',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  window.once('ready-to-show', () => {
    window.show();
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      platform: process.platform,
      title: 'OpenGameInstaller Fixture Game',
      visible: window.isVisible(),
    }, null, 2));
  });
  return window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><title>OpenGameInstaller Fixture Game</title></head>' +
    '<body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
    '<main><h1>Golden Journey Fixture</h1><p>The fixture game is running.</p>' +
    '<button aria-label="Close Fixture Game" onclick="require(&quot;electron&quot;).ipcRenderer.invoke(&quot;fixture-game:close&quot;)">Close Game</button>' +
    '</main></body></html>'
  ));
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
`;

export type FixturePayloadManifestEntry = {
  relativePath: string;
  size: number;
  sha256: string;
};

function fixturePayloadEntry(
  relativePath: string,
  contents: Buffer | string
): FixturePayloadManifestEntry {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return {
    relativePath,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export const FIXTURE_TORRENT_PAYLOAD_MANIFEST = [
  fixturePayloadEntry('fixture-game.cjs', FIXTURE_GAME_MAIN),
  fixturePayloadEntry('golden-journey.txt', FIXTURE_GAME_CONTENT),
] satisfies FixturePayloadManifestEntry[];

export function verifyExactFixtureTree(
  root: string,
  manifest: readonly FixturePayloadManifestEntry[]
) {
  const actualPaths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        actualPaths.push(relative(root, path).replaceAll('\\', '/'));
      } else {
        throw new Error(`Fixture tree contains unsupported entry: ${path}`);
      }
    }
  };
  visit(root);
  actualPaths.sort();
  const expectedPaths = manifest.map((entry) => entry.relativePath).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Fixture file set mismatch: expected ${JSON.stringify(expectedPaths)}, received ${JSON.stringify(actualPaths)}`
    );
  }
  for (const entry of manifest) {
    const path = join(root, entry.relativePath);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.size) {
      throw new Error(
        `${entry.relativePath} size mismatch: expected ${entry.size}, received ${bytes.byteLength}`
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) {
      throw new Error(`${entry.relativePath} SHA-256 mismatch`);
    }
  }
  return manifest;
}

export type TorrentLibraryRecord = {
  cwd: string;
  installDirectory: string;
  launchExecutable: string;
  version: '1.0.0';
  installRoot: string;
  capsuleImage: string;
  coverImage: string;
  name: 'Golden Journey Fixture';
  appID: 7001;
  storefront: 'ogi-e2e';
  addonsource: 'ogi-e2e-fixture-addon';
};

const TORRENT_LIBRARY_RECORD_KEYS = [
  'cwd',
  'installDirectory',
  'launchExecutable',
  'version',
  'installRoot',
  'capsuleImage',
  'coverImage',
  'name',
  'appID',
  'storefront',
  'addonsource',
] as const;

export function verifyExactTorrentLibraryState(options: {
  sandboxDirectory: string;
  libraryDirectory: string;
  expectedInstallRoot: string;
  fixtureBaseUrl: string;
  visibleItems: readonly {
    text: string;
    imageAlts: readonly string[];
  }[];
  launcherName: string;
}) {
  if (options.visibleItems.length !== 1) {
    throw new Error(
      `Expected exactly one visible Library item, received ${options.visibleItems.length}`
    );
  }
  const [visibleItem] = options.visibleItems;
  if (
    !visibleItem ||
    (!visibleItem.text.includes('Golden Journey Fixture') &&
      !visibleItem.imageAlts.includes('Golden Journey Fixture'))
  ) {
    throw new Error('Visible Library item is not Golden Journey Fixture');
  }

  const libraryEntries = readdirSync(options.libraryDirectory, {
    withFileTypes: true,
  });
  if (libraryEntries.length !== 1) {
    throw new Error(
      `Expected exactly one Library record, received ${libraryEntries.length}`
    );
  }
  const [libraryEntry] = libraryEntries;
  if (!libraryEntry?.isFile() || libraryEntry.name !== '7001.json') {
    throw new Error('Expected the only Library record to be 7001.json');
  }
  const libraryPath = join(options.libraryDirectory, libraryEntry.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(libraryPath, 'utf8'));
  } catch {
    throw new Error('Torrent-installed Library record is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Torrent-installed Library record is malformed');
  }
  const actualKeys = Object.keys(parsed).sort();
  const expectedKeys = [...TORRENT_LIBRARY_RECORD_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Torrent-installed Library record has unknown or missing fields: expected ${JSON.stringify(expectedKeys)}, received ${JSON.stringify(actualKeys)}`
    );
  }

  const library = parsed as Partial<TorrentLibraryRecord>;
  const sandboxDirectory = resolve(options.sandboxDirectory);
  const installRoot = resolve(options.expectedInstallRoot);
  const sandboxInstallRoot = join(sandboxDirectory, 'downloads');
  const installRootFromSandbox = relative(sandboxDirectory, installRoot);
  if (
    installRoot !== sandboxInstallRoot ||
    installRootFromSandbox === '' ||
    installRootFromSandbox === '..' ||
    installRootFromSandbox.startsWith(`..${sep}`) ||
    isAbsolute(installRootFromSandbox)
  ) {
    throw new Error(
      'Expected torrent install root is not the sandbox-contained downloads directory'
    );
  }
  const installDirectory = join(
    installRoot,
    'Golden Journey Fixture',
    'installed'
  );
  const launchExecutable = join(installDirectory, options.launcherName);
  let fixtureUrl: URL;
  try {
    fixtureUrl = new URL(options.fixtureBaseUrl);
  } catch {
    throw new Error('Torrent Fixture Service URL is invalid');
  }
  if (
    fixtureUrl.protocol !== 'http:' ||
    fixtureUrl.hostname !== '127.0.0.1' ||
    !fixtureUrl.port ||
    fixtureUrl.pathname !== '/' ||
    fixtureUrl.username ||
    fixtureUrl.password ||
    fixtureUrl.search ||
    fixtureUrl.hash
  ) {
    throw new Error(
      'Torrent Fixture Service URL must be an exact loopback HTTP origin'
    );
  }
  const expectedImageUrl = new URL('/images/golden-journey.svg', fixtureUrl)
    .href;
  if (
    library.cwd !== installDirectory ||
    library.installDirectory !== installDirectory ||
    library.launchExecutable !== launchExecutable ||
    library.version !== '1.0.0' ||
    library.installRoot !== installRoot ||
    library.capsuleImage !== expectedImageUrl ||
    library.coverImage !== expectedImageUrl ||
    library.name !== 'Golden Journey Fixture' ||
    library.appID !== 7001 ||
    library.storefront !== 'ogi-e2e' ||
    library.addonsource !== 'ogi-e2e-fixture-addon'
  ) {
    throw new Error('Torrent-installed Library record is invalid');
  }
  return {
    library: library as TorrentLibraryRecord,
    libraryPath,
    visibleLibraryItems: options.visibleItems.length,
    libraryRecords: libraryEntries.length,
  };
}
