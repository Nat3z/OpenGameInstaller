import { BrowserWindow, app, dialog, ipcMain, net } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path, { join } from 'path';
import yauzl from 'yauzl';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import http from 'node:http';
import https from 'node:https';
let mainWindow;
import pjson from '../package.json' with { type: 'json' };

function isDev() {
  return !app.isPackaged;
}

let __dirname = isDev()
  ? app.getAppPath() + '/'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}
console.log(__dirname);
const SETUP_VERSION = pjson.version;
fs.writeFile(join(__dirname, 'updater-version.txt'), SETUP_VERSION, () => {
  console.log('Wrote version file');
});
process.noAsar = true;

function correctParsingSize(size) {
  if (size < 1024) {
    return size + 'B';
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + 'KB';
  } else if (size < 1024 * 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(2) + 'MB';
  } else {
    return (size / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
  }
}

let localVersion = '0.0.0';
let usingBleedingEdge = false;
let updateChannel = 'stable';
if (fs.existsSync(`./version.txt`)) {
  localVersion = fs.readFileSync(`./version.txt`, 'utf8');
}
if (fs.existsSync(`./bleeding-edge.txt`)) {
  updateChannel = 'unstable';
  usingBleedingEdge = true;
}
if (fs.existsSync(`./COMMIT_EDGE.txt`)) {
  updateChannel = 'bleeding-edge';
}

const PATCH_PROGRESS_INTERVAL = 128;
const VERIFY_PROGRESS_INTERVAL = 128;
const RANGE_DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const RANGE_DOWNLOAD_CONCURRENCY = 6;
const RANGE_DOWNLOAD_COALESCE_GAP = 512 * 1024;
const PATCH_DOWNLOAD_PROGRESS_INTERVAL_MS = 100;
const HTTP_RETRY_ATTEMPTS = 4;
const HTTP_RETRY_BASE_DELAY_MS = 1500;
const HTTP_REQUEST_TIMEOUT_MS = 60000;
const PRESERVED_UPDATE_ENTRIES = new Set(['artifacts', 'latest.log', 'logs']);
const OGI_REPO_URL = 'https://github.com/Nat3z/OpenGameInstaller';
const HTTP_RANGE_AGENTS = {
  http: new http.Agent({
    keepAlive: true,
    maxSockets: RANGE_DOWNLOAD_CONCURRENCY,
  }),
  https: new https.Agent({
    keepAlive: true,
    maxSockets: RANGE_DOWNLOAD_CONCURRENCY,
  }),
};

function getRequestedOnlineState(argv = process.argv) {
  const onlineArg = argv.find((arg) => arg.startsWith('--online='));
  if (!onlineArg) {
    return null;
  }

  const value = onlineArg.slice('--online='.length).trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  return null;
}

function hasArg(name, argv = process.argv) {
  return argv.includes(name);
}

const DEFAULT_BLEEDING_EDGE_BRANCH = 'main';

type CommitEdgeTarget = { branch: string; commit: string };

function parseCommitEdgeFile(contents: string): CommitEdgeTarget {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let branch = DEFAULT_BLEEDING_EDGE_BRANCH;
  let commit = '';
  for (const line of lines) {
    const branchMatch = line.match(/^branch=(.+)$/i);
    const commitMatch = line.match(/^commit=(.*)$/i);
    if (branchMatch) {
      branch = branchMatch[1].trim() || DEFAULT_BLEEDING_EDGE_BRANCH;
      continue;
    }
    if (commitMatch) {
      commit = commitMatch[1].trim();
      continue;
    }
    if (!commit) {
      commit = line;
    }
  }
  return { branch, commit };
}

function writeCommitEdgeFile(branch: string, commit: string) {
  const lines = [`branch=${branch || DEFAULT_BLEEDING_EDGE_BRANCH}`];
  if (commit) {
    lines.push(`commit=${commit}`);
  }
  fs.writeFileSync('./COMMIT_EDGE.txt', `${lines.join('\n')}\n`);
}

function getCommitEdgeTarget(argv = process.argv): CommitEdgeTarget {
  const branchArg = argv.find((arg) => arg.startsWith('--branch='));
  const commitArg = argv.find((arg) => arg.startsWith('--commit='));
  const branch = branchArg
    ? branchArg.slice('--branch='.length).trim() || DEFAULT_BLEEDING_EDGE_BRANCH
    : '';
  const commit = commitArg ? commitArg.slice('--commit='.length).trim() : '';
  if (branch || commit) {
    return {
      branch: branch || DEFAULT_BLEEDING_EDGE_BRANCH,
      commit,
    };
  }
  if (fs.existsSync('./COMMIT_EDGE.txt')) {
    return parseCommitEdgeFile(fs.readFileSync('./COMMIT_EDGE.txt', 'utf8'));
  }
  return { branch: DEFAULT_BLEEDING_EDGE_BRANCH, commit: '' };
}

function getBleedingEdgeRepoDir() {
  if (process.platform === 'win32') {
    return path.join(app.getPath('appData'), 'ogi-repo');
  }
  return path.join(app.getPath('home'), '.local', 'share', 'ogi-repo');
}

function getApplicationBuildCommand() {
  return process.platform === 'win32'
    ? ['bun', ['run', '--cwd', 'application', 'electron-pack']]
    : ['bun', ['run', '--cwd', 'application', 'electron-pack:linux']];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    logUpdater(`Running command: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { ...options, shell: process.platform === 'win32' });
    child.stdout?.on('data', (data) => sendUpdaterStatus('Building Bleeding Edge', undefined, undefined, data.toString().trim().slice(-80)));
    child.stderr?.on('data', (data) => sendUpdaterStatus('Building Bleeding Edge', undefined, undefined, data.toString().trim().slice(-80)));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(undefined) : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function syncBleedingEdgeRepo(repoDir: string, branch: string) {
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  await runCommand('git', ['fetch', '--all', '--tags'], { cwd: repoDir });
  await runCommand('git', ['checkout', targetBranch], { cwd: repoDir });
  await runCommand(
    'git',
    ['pull', '--ff-only', 'origin', targetBranch],
    { cwd: repoDir }
  );
}

async function ensureBleedingEdgeBuild(
  commit = '',
  branch = DEFAULT_BLEEDING_EDGE_BRANCH
) {
  const repoDir = getBleedingEdgeRepoDir();
  const targetBranch = branch || DEFAULT_BLEEDING_EDGE_BRANCH;
  sendUpdaterStatus('Preparing Bleeding Edge');
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    await runCommand('git', [
      'clone',
      '--branch',
      targetBranch,
      OGI_REPO_URL,
      repoDir,
    ]);
  } else {
    await syncBleedingEdgeRepo(repoDir, targetBranch);
  }
  if (commit) {
    await runCommand('git', ['checkout', commit], { cwd: repoDir });
  }
  await runCommand('bun', ['install', '--linker=hoisted'], { cwd: repoDir });
  await runCommand('bun', ['run', 'build'], { cwd: repoDir });
  const [buildCommand, buildArgs] = getApplicationBuildCommand();
  await runCommand(buildCommand, buildArgs, { cwd: repoDir });

  const destRoot = path.join(__dirname, 'update');
  prepareUpdateDestination(destRoot);
  if (process.platform === 'win32') {
    const exe = findFirstFile(path.join(repoDir, 'application', 'dist'), (name) => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().includes('setup'));
    if (!exe) throw new Error('Built Windows executable not found');
    fs.copyFileSync(exe, path.join(destRoot, 'OpenGameInstaller.exe'));
  } else {
    const appImage = findFirstFile(path.join(repoDir, 'application', 'dist'), (name) => name.toLowerCase().endsWith('.appimage'));
    if (!appImage) throw new Error('Built Linux AppImage not found');
    fs.copyFileSync(appImage, path.join(destRoot, 'OpenGameInstaller.AppImage'));
    fs.chmodSync(path.join(destRoot, 'OpenGameInstaller.AppImage'), '755');
  }
  writeCommitEdgeFile(targetBranch, commit);
}

const GITHUB_REPO = OGI_REPO_URL.replace('https://github.com/', '');

async function getBranchTipDate(branch: string) {
  const response = await axios.get(
    `https://api.github.com/repos/${GITHUB_REPO}/commits`,
    { params: { sha: branch, per_page: 1 }, timeout: 10000 }
  );
  return response.data[0]?.commit?.author?.date || '';
}

async function getBranches() {
  const response = await axios.get(
    `https://api.github.com/repos/${GITHUB_REPO}/branches`,
    { params: { per_page: 100 }, timeout: 10000 }
  );
  const names = response.data.map(
    (branch: { name: string }) => branch.name
  ) as string[];
  const datedBranches = await Promise.all(
    names.map(async (name) => ({
      name,
      date: await getBranchTipDate(name).catch(() => ''),
    }))
  );
  const others = datedBranches
    .filter((branch) => branch.name !== 'main')
    .sort(
      (a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
    )
    .map((branch) => branch.name);
  return names.includes('main') ? ['main', ...others] : others;
}

async function getRecentCommits(branch = DEFAULT_BLEEDING_EDGE_BRANCH) {
  const response = await axios.get(
    `https://api.github.com/repos/${GITHUB_REPO}/commits`,
    {
      params: { per_page: 12, sha: branch || DEFAULT_BLEEDING_EDGE_BRANCH },
      timeout: 10000,
    }
  );
  return response.data.map((commit) => ({
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message: commit.commit?.message?.split('\n')[0] || 'No commit message',
    author: commit.commit?.author?.name || 'Unknown',
    date: commit.commit?.author?.date || '',
  }));
}

ipcMain.handle('get-branches', async () => {
  try {
    return { ok: true, branches: await getBranches() };
  } catch (error) {
    console.error('Failed to load branches:', error);
    return {
      ok: false,
      branches: [DEFAULT_BLEEDING_EDGE_BRANCH],
      error: error?.message || 'Failed to load branches',
    };
  }
});

ipcMain.handle('get-recent-commits', async (_event, branch) => {
  try {
    return {
      ok: true,
      commits: await getRecentCommits(
        typeof branch === 'string' && branch ? branch : DEFAULT_BLEEDING_EDGE_BRANCH
      ),
    };
  } catch (error) {
    console.error('Failed to load recent commits:', error);
    return { ok: false, commits: [], error: error?.message || 'Failed to load commits' };
  }
});

function findFirstFile(root, predicate) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstFile(fullPath, predicate);
      if (found) return found;
    } else if (predicate(entry.name, fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function getEffectiveOnlineState(requestedOnline = getRequestedOnlineState()) {
  const networkOnline = net.isOnline();

  if (!networkOnline) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'network-offline',
    };
  }

  if (requestedOnline === false) {
    return {
      requestedOnline,
      networkOnline,
      effectiveOnline: false,
      reason: 'cli-offline',
    };
  }

  return {
    requestedOnline,
    networkOnline,
    effectiveOnline: true,
    reason: 'online',
  };
}

function parseReleaseVersion(tagName) {
  if (typeof tagName !== 'string') {
    return null;
  }

  const match = tagName
    .trim()
    .replace(/^v/i, '')
    .match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
    );
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifier(a, b) {
  const aIsNumeric = /^\d+$/.test(a);
  const bIsNumeric = /^\d+$/.test(b);

  if (aIsNumeric && bIsNumeric) {
    const aNumber = Number.parseInt(a, 10);
    const bNumber = Number.parseInt(b, 10);
    if (aNumber > bNumber) return 1;
    if (aNumber < bNumber) return -1;
    return 0;
  }

  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function compareParsedReleaseVersion(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  const aHasPrerelease = a.prerelease.length > 0;
  const bHasPrerelease = b.prerelease.length > 0;
  if (!aHasPrerelease && !bHasPrerelease) return 0;
  if (!aHasPrerelease) return 1;
  if (!bHasPrerelease) return -1;

  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < maxLength; i++) {
    const aIdentifier = a.prerelease[i];
    const bIdentifier = b.prerelease[i];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;

    const identifierOrder = comparePrereleaseIdentifier(
      aIdentifier,
      bIdentifier
    );
    if (identifierOrder !== 0) {
      return identifierOrder;
    }
  }

  return 0;
}

function compareReleaseOrder(a, b) {
  const parsedA = parseReleaseVersion(a?.tag_name);
  const parsedB = parseReleaseVersion(b?.tag_name);

  if (parsedA && parsedB) {
    const semanticOrder = compareParsedReleaseVersion(parsedB, parsedA);
    if (semanticOrder !== 0) {
      return semanticOrder;
    }
  }

  return (
    new Date(b?.published_at || b?.created_at || 0).getTime() -
    new Date(a?.published_at || a?.created_at || 0).getTime()
  );
}

function sendUpdaterStatus(text, progress?, max?, subtext?) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('text', text, progress, max, subtext);
}

function prepareUpdateDestination(destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(destRoot)) {
    if (PRESERVED_UPDATE_ENTRIES.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(destRoot, entry), { recursive: true, force: true });
  }
}

function nextUiTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function logUpdater(message, ...args) {
  console.log(`[updater] ${message}`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt) {
  return HTTP_RETRY_BASE_DELAY_MS * attempt;
}

function shouldRetryHttpError(error) {
  const code = error?.code;
  const message =
    typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const status = error?.response?.status;

  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('timeout')
  );
}

function getAxiosTransportOptions(url) {
  if (typeof url !== 'string') {
    return {};
  }
  if (url.startsWith('https://')) {
    return { httpsAgent: HTTP_RANGE_AGENTS.https };
  }
  if (url.startsWith('http://')) {
    return { httpAgent: HTTP_RANGE_AGENTS.http };
  }
  return {};
}

/**
 * Create and display the updater window, ensure no other instance is running, and handle update checking, download, installation, and app launch.
 *
 * This function:
 * - Verifies that no other instance is serving on localhost:7654 and exits if one is found.
 * - Creates the frameless updater BrowserWindow and prevents DevTools from opening.
 * - If the device is offline, notifies the UI and launches OpenGameInstaller in offline mode.
 * - When online, queries GitHub Releases for a newer release (respecting bleeding-edge prerelease selection), and either:
 *   - Uses a cached release if present and valid, copying files into ./update and writing ./version.txt, or
 *   - Downloads the appropriate platform asset, reports progress to the UI, extracts or places files into ./update (and a temp cache), writes ./version.txt, adjusts execution permissions on Linux, and then launches OpenGameInstaller.
 * - Falls back to launching the existing installed version if update operations fail or no update is found.
 *
 * Side effects:
 * - Creates and writes files under the app directory (e.g., ./update, ./version.txt) and the OS temp directory for caches.
 * - May spawn the OpenGameInstaller process and exit the host app.
 * - Sends status messages to the renderer via mainWindow.webContents.send.
 */
async function createWindow() {
  // check if port 7654 is open, if not, start the server
  try {
    const port_check = await fetch('http://localhost:7654');
    if (port_check.ok) {
      console.error(
        'Port 7654 is already in use, meaning OpenGameInstaller is already running. Exiting.'
      );
      dialog.showErrorBox(
        'OpenGameInstaller is already running',
        'OpenGameInstaller is already running. Please close the other instance before launching OpenGameInstaller again.'
      );
      app.exit(1);
    }
  } catch {
    console.log("Port isn't in use! Launching....");
  }

  mainWindow = new BrowserWindow({
    width: 300,
    height: 400,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: isDev()
        ? `${app.getAppPath()}/dist/preload.js`
        : `${app.getAppPath()}/dist/preload.js`,
      nodeIntegration: true,
      devTools: false,
      contextIsolation: true,
    },
  });
  await mainWindow.loadURL(`file://${app.getAppPath()}/public/index.html`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // disable opening devtools
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  const initialOnlineState = getEffectiveOnlineState();
  if (!initialOnlineState.effectiveOnline) {
    console.log(
      initialOnlineState.reason === 'cli-offline'
        ? 'Updater requested offline mode, skipping update check'
        : 'Device is offline, skipping update check'
    );
    mainWindow.webContents.send(
      'text',
      'Launching OpenGameInstaller',
      'Offline Mode'
    );
    launchApp(false);
    return;
  }

  if (hasArg('--gui')) {
    mainWindow.webContents.send('show-channel-picker');
    const choice: any = await new Promise((resolve) => {
      ipcMain.once('choose-channel', (_event, payload) => resolve(payload));
    });
    const channel = choice?.channel || 'stable';
    if (channel === 'stable') {
      fs.rmSync('./bleeding-edge.txt', { force: true });
      fs.rmSync('./COMMIT_EDGE.txt', { force: true });
      usingBleedingEdge = false;
    } else if (channel === 'unstable') {
      fs.writeFileSync('./bleeding-edge.txt', 'true');
      fs.rmSync('./COMMIT_EDGE.txt', { force: true });
      usingBleedingEdge = true;
    } else if (channel === 'bleeding-edge') {
      try {
        await ensureBleedingEdgeBuild(
          (choice?.commit || '').trim(),
          (choice?.branch || DEFAULT_BLEEDING_EDGE_BRANCH).trim()
        );
        mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
        launchApp(true);
        return;
      } catch (err) {
        console.error(err);
        mainWindow.webContents.send('text', 'Bleeding Edge Failed', err.message);
        launchApp(true);
        return;
      }
    }
  } else if (updateChannel === 'bleeding-edge') {
    try {
      const { branch, commit } = getCommitEdgeTarget();
      await ensureBleedingEdgeBuild(commit, branch);
      mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      launchApp(true);
      return;
    } catch (err) {
      console.error(err);
      mainWindow.webContents.send('text', 'Bleeding Edge Failed', err.message);
      launchApp(true);
      return;
    }
  }

  // check for updates
  const gitRepo = 'Nat3z/OpenGameInstaller';

  // check the github releases
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${gitRepo}/releases`,
      { timeout: 10000 } // 10 second timeout for update check
    );
    mainWindow.webContents.send('text', 'Checking for Updates');
    const releases = response.data
      .filter((rel) => usingBleedingEdge || !rel.prerelease)
      .sort(compareReleaseOrder);
    const localIndex = releases.findIndex(
      (rel) => rel.tag_name === localVersion
    );
    const targetRelease = releases[0];
    let updating = Boolean(targetRelease) && localIndex !== 0;
    if (targetRelease && updating) {
      const releasePath =
        localIndex > 0
          ? releases.slice(0, localIndex).reverse()
          : [targetRelease];
      const gap =
        localIndex > 0 ? releasePath.length : Number.POSITIVE_INFINITY;
      let updateApplied = false;

      if (Number.isFinite(gap) && gap > 0 && gap <= 3) {
        mainWindow.webContents.send(
          'text',
          'Preparing incremental update path'
        );
        try {
          await applyBlockmapPath(releasePath, releases);
          updateApplied = true;
        } catch (patchErr) {
          console.error('Incremental patching failed, falling back:', patchErr);
          mainWindow.webContents.send(
            'text',
            'Falling back to full download',
            patchErr.message
          );
        }
      } else if (!Number.isFinite(gap)) {
        mainWindow.webContents.send(
          'text',
          'Falling back to full download',
          'Local version missing from release feed'
        );
      } else {
        mainWindow.webContents.send(
          'text',
          'Falling back to full download',
          'Version too old for incremental update'
        );
      }

      if (!updateApplied) {
        await downloadFullRelease(targetRelease);
      }
      fs.writeFileSync(`./version.txt`, targetRelease.tag_name);
      mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      launchApp(true);
      return;
    }
    if (!updating) {
      mainWindow.webContents.send(
        'text',
        'Launching OpenGameInstaller',
        'No Updates Found'
      );
      launchApp(true);
    }
  } catch (e) {
    console.error(e);
    const onlineState = getEffectiveOnlineState();
    if (!onlineState.effectiveOnline) {
      mainWindow.webContents.send(
        'text',
        'Launching OpenGameInstaller',
        'Offline Mode'
      );
      launchApp(false);
      return;
    }
    mainWindow.webContents.send(
      'text',
      'Launching OpenGameInstaller',
      'Failed to check for updates'
    );
    launchApp(true);
  }
}

function getVersionCache(tagName) {
  return path.join(
    app.getPath('temp'),
    `ogi-${tagName.replace('v', '')}-cache`
  );
}

function cleanOldVersionCaches(currentTag) {
  const tempRoot = app.getPath('temp');
  if (!fs.existsSync(tempRoot)) {
    return;
  }
  const keepCacheName =
    typeof currentTag === 'string' && currentTag.length > 0
      ? path.basename(getVersionCache(currentTag))
      : null;
  for (const entry of fs.readdirSync(tempRoot)) {
    if (!entry.startsWith('ogi-') || !entry.endsWith('-cache')) {
      continue;
    }
    if (keepCacheName && entry === keepCacheName) {
      continue;
    }
    fs.rmSync(path.join(tempRoot, entry), { recursive: true, force: true });
  }
}

function getPersistentArtifactDir() {
  return path.join(__dirname, 'update', 'artifacts');
}

function getPersistentArtifactPath(assetName) {
  return path.join(getPersistentArtifactDir(), assetName);
}

function persistSourceArtifact(assetName, sourcePath) {
  if (process.platform !== 'win32') {
    return;
  }
  const persistentPath = getPersistentArtifactPath(assetName);
  fs.mkdirSync(path.dirname(persistentPath), { recursive: true });
  fs.copyFileSync(sourcePath, persistentPath);
}

function cleanOldArtifacts(currentAssetName) {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = getPersistentArtifactDir();
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    if (file === currentAssetName) {
      continue;
    }
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  }
}

function cleanupAfterUpdate(currentTag, currentAssetName) {
  try {
    cleanOldArtifacts(currentAssetName);
  } catch (err) {
    console.error('Failed to clean old persistent artifacts:', err);
  }
  try {
    cleanOldVersionCaches(currentTag);
  } catch (err) {
    console.error('Failed to clean old temp caches:', err);
  }
}

function getPlatformAsset(release) {
  if (process.platform === 'win32') {
    return release.assets.find(
      (asset) =>
        asset.name.toLowerCase().includes('portable') ||
        asset.name.toLowerCase().includes('portrable')
    );
  }
  return release.assets.find((asset) =>
    asset.name.toLowerCase().includes('linux-pt.appimage')
  );
}

function getBlockmapAsset(release, targetAsset) {
  return release.assets.find(
    (asset) =>
      asset.name.toLowerCase() === `${targetAsset.name.toLowerCase()}.blockmap`
  );
}

function getReleaseByTag(releases, tagName) {
  return releases.find((release) => release.tag_name === tagName);
}

function getBlockKey(checksum, size) {
  return `${checksum}:${size}`;
}

async function ensureCachedSourceArtifact(cacheDir, release, asset) {
  const sourceArtifactPath = path.join(cacheDir, asset.name);
  if (fs.existsSync(sourceArtifactPath)) {
    return sourceArtifactPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  // On Linux we usually have the currently installed AppImage available locally.
  if (process.platform === 'linux') {
    const installedAppImage = path.join(
      __dirname,
      'update',
      'OpenGameInstaller.AppImage'
    );
    if (fs.existsSync(installedAppImage)) {
      fs.copyFileSync(installedAppImage, sourceArtifactPath);
      return sourceArtifactPath;
    }
  }
  if (process.platform === 'win32') {
    const persistentArtifact = getPersistentArtifactPath(asset.name);
    if (fs.existsSync(persistentArtifact)) {
      fs.copyFileSync(persistentArtifact, sourceArtifactPath);
      return sourceArtifactPath;
    }
    // Compatibility with older updater versions that may have copied archives
    // into ./update directly.
    const legacyArtifact = path.join(__dirname, 'update', asset.name);
    if (fs.existsSync(legacyArtifact)) {
      fs.copyFileSync(legacyArtifact, sourceArtifactPath);
      return sourceArtifactPath;
    }
  }

  await downloadToFile(
    asset.browser_download_url,
    sourceArtifactPath,
    `Downloading base artifact ${release.tag_name}`
  );
  persistSourceArtifact(asset.name, sourceArtifactPath);
  return sourceArtifactPath;
}

async function ensureCachedBlockmap(cacheDir, release, asset) {
  const blockmapAsset = getBlockmapAsset(release, asset);
  if (!blockmapAsset) {
    throw new Error(`Blockmap missing for ${release.tag_name}`);
  }

  const blockmapPath = path.join(cacheDir, `${asset.name}.blockmap`);
  if (fs.existsSync(blockmapPath)) {
    return blockmapPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  await downloadToFile(
    blockmapAsset.browser_download_url,
    blockmapPath,
    `Downloading blockmap ${release.tag_name}`
  );
  return blockmapPath;
}

async function downloadToFile(url, destination, status) {
  logUpdater(`Starting download: ${status}`, { url, destination });
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
    let writer;
    let response;
    try {
      fs.rmSync(destination, { force: true });
      writer = fs.createWriteStream(destination);
      response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: HTTP_REQUEST_TIMEOUT_MS,
        ...getAxiosTransportOptions(url),
      });
      response.data.pipe(writer);
      const startTime = Date.now();
      const fileSize = response.headers['content-length'];
      response.data.on('data', () => {
        const elapsedTime = (Date.now() - startTime) / 1000;
        const downloadSpeed = writer.bytesWritten / Math.max(elapsedTime, 1);
        sendUpdaterStatus(
          status,
          writer.bytesWritten,
          fileSize,
          correctParsingSize(downloadSpeed) + '/s'
        );
      });
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });
      logUpdater(`Finished download: ${status}`, {
        destination,
        bytesWritten: writer.bytesWritten,
        attempt,
      });
      return;
    } catch (error) {
      writer?.destroy();
      response?.data?.destroy?.();
      fs.rmSync(destination, { force: true });

      const retryable = shouldRetryHttpError(error);
      logUpdater(`Download attempt failed: ${status}`, {
        destination,
        attempt,
        retryable,
        error: error?.message,
        code: error?.code,
        statusCode: error?.response?.status,
      });
      if (!retryable || attempt === HTTP_RETRY_ATTEMPTS) {
        throw error;
      }
      const delayMs = getRetryDelay(attempt);
      sendUpdaterStatus(
        status,
        undefined,
        undefined,
        `Retrying (${attempt + 1}/${HTTP_RETRY_ATTEMPTS})`
      );
      await sleep(delayMs);
    }
  }
}

function copyCacheToUpdate(cacheDir) {
  const files = fs.readdirSync(cacheDir);
  const destRoot = path.join(__dirname, 'update');
  prepareUpdateDestination(destRoot);
  for (const file of files) {
    const lowerName = file.toLowerCase();
    if (lowerName.endsWith('.blockmap')) {
      continue;
    }
    if (process.platform === 'win32' && lowerName.endsWith('.zip')) {
      continue;
    }
    if (
      process.platform === 'linux' &&
      lowerName.endsWith('.appimage') &&
      lowerName !== 'opengameinstaller.appimage'
    ) {
      continue;
    }
    fs.cpSync(path.join(cacheDir, file), path.join(destRoot, file), {
      force: true,
      recursive: true,
    });
  }
}

async function downloadFullRelease(release) {
  const assetWithPortable = getPlatformAsset(release);
  if (!assetWithPortable) {
    throw new Error('No portable asset found for this platform');
  }
  const localCache = getVersionCache(release.tag_name);
  fs.mkdirSync(localCache, { recursive: true });
  const blockmapAsset = getBlockmapAsset(release, assetWithPortable);

  sendUpdaterStatus('Downloading Update');
  const downloadPath =
    process.platform === 'win32'
      ? path.join(__dirname, 'update.zip')
      : './update/OpenGameInstaller.AppImage';
  if (process.platform === 'linux') {
    fs.mkdirSync('./update', { recursive: true });
  }
  await downloadToFile(
    assetWithPortable.browser_download_url,
    downloadPath,
    'Downloading Update'
  );
  sendUpdaterStatus('Verifying Download');
  await verifyReleaseArtifact(
    downloadPath,
    {
      size: assetWithPortable.size,
      digest: assetWithPortable.digest,
    },
    'downloaded release artifact'
  );
  if (blockmapAsset) {
    await downloadToFile(
      blockmapAsset.browser_download_url,
      path.join(localCache, `${assetWithPortable.name}.blockmap`),
      'Downloading blockmap'
    );
  }
  sendUpdaterStatus('Download Complete');

  if (process.platform === 'win32') {
    const zipPath = path.join(__dirname, 'update.zip');
    persistSourceArtifact(assetWithPortable.name, zipPath);
    sendUpdaterStatus('Extracting Update');
    await unzip(zipPath, localCache);
    sendUpdaterStatus('Copying Update Files');
    copyCacheToUpdate(localCache);
    fs.copyFileSync(zipPath, path.join(localCache, assetWithPortable.name));
    fs.unlinkSync(zipPath);
  } else {
    const item = path.join(__dirname, 'update', 'OpenGameInstaller.AppImage');
    fs.copyFileSync(item, path.join(localCache, 'OpenGameInstaller.AppImage'));
    fs.copyFileSync(item, path.join(localCache, assetWithPortable.name));
    fs.chmodSync(item, '755');
  }
  cleanupAfterUpdate(release.tag_name, assetWithPortable.name);
}

async function applyBlockmapPath(releasePath, releases) {
  let currentTag = localVersion;
  let latestAssetName = null;
  logUpdater('Starting incremental update path', {
    from: currentTag,
    steps: releasePath.map((release) => release.tag_name),
  });
  for (let i = 0; i < releasePath.length; i++) {
    const currentRelease = getReleaseByTag(releases, currentTag);
    const nextRelease = releasePath[i];
    logUpdater('Applying incremental patch step', {
      step: i + 1,
      totalSteps: releasePath.length,
      from: currentTag,
      to: nextRelease.tag_name,
    });
    sendUpdaterStatus(`Applying patch ${i + 1} of ${releasePath.length}`);
    if (!currentRelease) {
      throw new Error(`Release metadata missing for ${currentTag}`);
    }
    const fromCache = getVersionCache(currentTag);
    const nextCache = getVersionCache(nextRelease.tag_name);
    const currentAsset = getPlatformAsset(currentRelease);
    if (!currentAsset) {
      throw new Error(`Portable asset missing for ${currentTag}`);
    }
    const nextAsset = getPlatformAsset(nextRelease);
    if (!nextAsset) {
      throw new Error(`Portable asset missing for ${nextRelease.tag_name}`);
    }
    latestAssetName = nextAsset.name;
    const newBlockmapAsset = getBlockmapAsset(nextRelease, nextAsset);
    if (!newBlockmapAsset) {
      throw new Error(`Blockmap missing for ${nextRelease.tag_name}`);
    }
    const sourceArtifact = await ensureCachedSourceArtifact(
      fromCache,
      currentRelease,
      currentAsset
    );
    sendUpdaterStatus('Verifying base artifact');
    await verifyReleaseArtifact(
      sourceArtifact,
      {
        size: currentAsset.size,
        digest: currentAsset.digest,
      },
      'base artifact'
    );
    const oldBlockmapPath = await ensureCachedBlockmap(
      fromCache,
      currentRelease,
      currentAsset
    );
    fs.mkdirSync(nextCache, { recursive: true });
    const newBlockmapPath = path.join(nextCache, `${nextAsset.name}.blockmap`);
    if (!fs.existsSync(newBlockmapPath)) {
      await downloadToFile(
        newBlockmapAsset.browser_download_url,
        newBlockmapPath,
        'Downloading blockmap'
      );
    }
    const outputArtifact = path.join(nextCache, nextAsset.name);
    logUpdater('Prepared patch inputs', {
      sourceArtifact,
      oldBlockmapPath,
      newBlockmapPath,
      outputArtifact,
    });
    sendUpdaterStatus(
      `Building patch ${i + 1} of ${releasePath.length}`,
      0,
      1,
      nextRelease.tag_name
    );
    await nextUiTick();
    await applyBlockmapPatch(
      sourceArtifact,
      oldBlockmapPath,
      outputArtifact,
      newBlockmapPath,
      nextAsset.browser_download_url,
      { size: nextAsset.size, digest: nextAsset.digest },
      {
        patchLabel: `Building patch ${i + 1} of ${releasePath.length}`,
        verifyLabel: `Verifying patch ${i + 1} of ${releasePath.length}`,
        releaseTag: nextRelease.tag_name,
      }
    );

    if (process.platform === 'win32') {
      persistSourceArtifact(nextAsset.name, outputArtifact);
      logUpdater('Extracting patched Windows artifact', {
        artifact: outputArtifact,
        destination: nextCache,
      });
      sendUpdaterStatus(
        `Extracting patch ${i + 1} of ${releasePath.length}`,
        0,
        1,
        nextRelease.tag_name
      );
      await nextUiTick();
      await unzip(outputArtifact, nextCache);
    } else {
      logUpdater('Finalizing patched Linux artifact', {
        artifact: outputArtifact,
        destination: path.join(nextCache, 'OpenGameInstaller.AppImage'),
      });
      sendUpdaterStatus(
        `Finalizing patch ${i + 1} of ${releasePath.length}`,
        0,
        1,
        nextRelease.tag_name
      );
      fs.copyFileSync(
        outputArtifact,
        path.join(nextCache, 'OpenGameInstaller.AppImage')
      );
    }
    currentTag = nextRelease.tag_name;
    logUpdater('Completed incremental patch step', {
      step: i + 1,
      currentTag,
    });
  }
  sendUpdaterStatus('Copying Update Files');
  logUpdater('Copying patched cache into update directory', {
    cache: getVersionCache(releasePath[releasePath.length - 1].tag_name),
  });
  copyCacheToUpdate(
    getVersionCache(releasePath[releasePath.length - 1].tag_name)
  );
  if (process.platform === 'linux') {
    sendUpdaterStatus('Finishing Update');
    fs.chmodSync('./update/OpenGameInstaller.AppImage', '755');
  }
  logUpdater('Incremental update path complete', {
    finalTag: releasePath[releasePath.length - 1].tag_name,
    latestAssetName,
  });
  cleanupAfterUpdate(
    releasePath[releasePath.length - 1].tag_name,
    latestAssetName
  );
}

async function applyBlockmapPatch(
  sourceArtifact,
  oldBlockmapPath,
  outputArtifact,
  newBlockmapPath,
  targetUrl,
  expectedArtifact = {},
  statusLabels: any = {}
) {
  const patchLabel = statusLabels.patchLabel || 'Building patch';
  const verifyLabel = statusLabels.verifyLabel || 'Verifying patch';
  const releaseTag = statusLabels.releaseTag;
  logUpdater('Starting blockmap patch', {
    sourceArtifact,
    oldBlockmapPath,
    newBlockmapPath,
    outputArtifact,
    releaseTag,
  });
  const oldMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(oldBlockmapPath)).toString('utf8'));
  const newMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(newBlockmapPath)).toString('utf8'));
  const oldFile = oldMap.files?.[0];
  const newFile = newMap.files?.[0];
  if (!oldFile || !newFile) {
    throw new Error('Invalid blockmap payload');
  }
  const checksumToBlocks = new Map();
  let oldOffset = oldFile.offset || 0;
  for (let i = 0; i < oldFile.checksums.length; i++) {
    const key = getBlockKey(oldFile.checksums[i], oldFile.sizes[i]);
    const block = { offset: oldOffset, size: oldFile.sizes[i] };
    const current = checksumToBlocks.get(key) || [];
    current.push(block);
    checksumToBlocks.set(key, current);
    oldOffset += oldFile.sizes[i];
  }

  fs.mkdirSync(path.dirname(outputArtifact), { recursive: true });
  let sourceFd;
  let outFd;

  try {
    sourceFd = fs.openSync(sourceArtifact, 'r');
    outFd = fs.openSync(outputArtifact, 'w');
    let writeOffset = newFile.offset || 0;
    const misses = [];

    if (writeOffset > 0) {
      sendUpdaterStatus(patchLabel, 0, newFile.checksums.length, releaseTag);
      await nextUiTick();
      const headerChunk = await downloadRangeChunk(
        targetUrl,
        0,
        writeOffset - 1
      );
      fs.writeSync(outFd, headerChunk, 0, headerChunk.length, 0);
    }

    for (let i = 0; i < newFile.checksums.length; i++) {
      const size = newFile.sizes[i];
      const blocks = checksumToBlocks.get(
        getBlockKey(newFile.checksums[i], size)
      );
      // Consume one old block at most once to avoid reusing source data.
      const matched = takeMatchingBlock(blocks);
      if (matched) {
        const buffer = Buffer.alloc(size);
        const bytesRead = fs.readSync(
          sourceFd,
          buffer,
          0,
          size,
          matched.offset
        );
        if (bytesRead !== size) {
          throw new Error(
            `Short read from source artifact at ${matched.offset}: expected ${size}, got ${bytesRead}`
          );
        }
        fs.writeSync(outFd, buffer, 0, size, writeOffset);
      } else {
        misses.push({ offset: writeOffset, size });
      }
      writeOffset += size;
      if (
        i === newFile.checksums.length - 1 ||
        (i + 1) % PATCH_PROGRESS_INTERVAL === 0
      ) {
        sendUpdaterStatus(
          patchLabel,
          i + 1,
          newFile.checksums.length,
          releaseTag
        );
        await nextUiTick();
      }
    }

    const mergedMisses = [];
    for (const miss of misses) {
      const last = mergedMisses[mergedMisses.length - 1];
      if (last && last.offset + last.size === miss.offset) {
        last.size += miss.size;
      } else {
        mergedMisses.push({ ...miss });
      }
    }

    const totalMissBytes = mergedMisses.reduce(
      (total, miss) => total + miss.size,
      0
    );
    const reusedBytes =
      newFile.sizes.reduce((total, size) => total + size, 0) - totalMissBytes;
    const downloadTasks = createRangeDownloadTasks(mergedMisses);
    const totalScheduledDownloadBytes = downloadTasks.reduce(
      (total, task) => total + task.size,
      0
    );
    logUpdater('Patch block analysis complete', {
      releaseTag,
      blockCount: newFile.checksums.length,
      missingRanges: mergedMisses.length,
      downloadTasks: downloadTasks.length,
      totalMissBytes,
      totalScheduledDownloadBytes,
      reusedBytes,
    });
    await downloadMissingPatchRanges(
      targetUrl,
      outFd,
      downloadTasks,
      releaseTag
    );
  } finally {
    if (typeof sourceFd === 'number') {
      try {
        fs.closeSync(sourceFd);
      } catch (closeErr) {
        console.error('Failed to close source file descriptor:', closeErr);
      }
    }
    if (typeof outFd === 'number') {
      try {
        fs.closeSync(outFd);
      } catch (closeErr) {
        console.error('Failed to close output file descriptor:', closeErr);
      }
    }
  }
  if (
    !fs.existsSync(outputArtifact) ||
    fs.statSync(outputArtifact).size === 0
  ) {
    throw new Error('Patched artifact is empty');
  }
  sendUpdaterStatus(verifyLabel, 0, newFile.checksums.length, releaseTag);
  await nextUiTick();
  logUpdater('Starting patched artifact verification', {
    outputArtifact,
    releaseTag,
  });
  await verifyPatchedArtifact(
    outputArtifact,
    newFile,
    expectedArtifact,
    verifyLabel,
    releaseTag
  );
  logUpdater('Completed blockmap patch', {
    outputArtifact,
    releaseTag,
  });
}

function takeMatchingBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }
  return blocks.pop();
}

function createRangeDownloadTasks(misses) {
  if (!Array.isArray(misses) || misses.length === 0) {
    return [];
  }

  const coalescedRanges = [];
  for (const miss of misses) {
    const lastRange = coalescedRanges[coalescedRanges.length - 1];
    const missEnd = miss.offset + miss.size;
    if (!lastRange) {
      coalescedRanges.push({ offset: miss.offset, size: miss.size });
      continue;
    }

    const lastEnd = lastRange.offset + lastRange.size;
    const gap = miss.offset - lastEnd;
    if (gap >= 0 && gap <= RANGE_DOWNLOAD_COALESCE_GAP) {
      lastRange.size = missEnd - lastRange.offset;
      continue;
    }

    coalescedRanges.push({ offset: miss.offset, size: miss.size });
  }

  const tasks = [];
  for (const range of coalescedRanges) {
    let start = range.offset;
    const end = range.offset + range.size - 1;
    while (start <= end) {
      const chunkEnd = Math.min(start + RANGE_DOWNLOAD_CHUNK_SIZE - 1, end);
      tasks.push({
        start,
        end: chunkEnd,
        size: chunkEnd - start + 1,
      });
      start = chunkEnd + 1;
    }
  }
  return tasks;
}

async function downloadMissingPatchRanges(targetUrl, outFd, tasks, releaseTag) {
  const totalBytes = tasks.reduce((total, task) => total + task.size, 0);
  if (totalBytes <= 0) {
    sendUpdaterStatus('Downloading patch data', 0, 1, releaseTag);
    return;
  }

  let downloadedBytes = 0;
  let nextTaskIndex = 0;
  let lastProgressAt = 0;

  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < PATCH_DOWNLOAD_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    sendUpdaterStatus(
      'Downloading patch data',
      downloadedBytes,
      totalBytes,
      releaseTag
    );
  };

  reportProgress(true);

  const workerCount = Math.min(RANGE_DOWNLOAD_CONCURRENCY, tasks.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= tasks.length) {
          return;
        }

        const task = tasks[taskIndex];
        logUpdater('Downloading patch data range', {
          releaseTag,
          start: task.start,
          end: task.end,
          size: task.size,
          task: taskIndex + 1,
          totalTasks: tasks.length,
        });

        const chunk = await downloadRangeChunk(targetUrl, task.start, task.end);
        fs.writeSync(outFd, chunk, 0, chunk.length, task.start);
        downloadedBytes += chunk.length;

        logUpdater('Downloaded patch data range', {
          releaseTag,
          start: task.start,
          end: task.end,
          chunkSize: chunk.length,
          downloadedBytes,
          totalBytes,
        });
        reportProgress();
      }
    })
  );

  reportProgress(true);
}

async function downloadRangeChunk(url, start, end) {
  const requestedRange = `bytes=${start}-${end}`;
  for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt++) {
    try {
      logUpdater('Requesting HTTP range', { url, requestedRange, attempt });
      const rangeResponse = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: {
          Range: requestedRange,
          'Accept-Encoding': 'identity',
        },
        timeout: HTTP_REQUEST_TIMEOUT_MS,
        ...getAxiosTransportOptions(url),
      });
      const expectedSize = end - start + 1;
      const actualSize = Buffer.byteLength(rangeResponse.data);
      const contentRange = rangeResponse.headers['content-range'];
      const expectedContentRangePrefix = `bytes ${start}-${end}/`;
      if (rangeResponse.status !== 206) {
        throw new Error(
          `Invalid range response status ${rangeResponse.status} for ${requestedRange}`
        );
      }
      if (actualSize !== expectedSize) {
        throw new Error(
          `Invalid range response length ${actualSize} for ${requestedRange}; expected ${expectedSize}`
        );
      }
      if (
        typeof contentRange !== 'string' ||
        !contentRange.startsWith(expectedContentRangePrefix)
      ) {
        throw new Error(
          `Invalid content-range header for ${requestedRange}: ${contentRange}`
        );
      }
      logUpdater('Received HTTP range', {
        requestedRange,
        actualSize,
        contentRange,
        attempt,
      });
      return Buffer.from(rangeResponse.data);
    } catch (error) {
      const retryable = shouldRetryHttpError(error);
      logUpdater('HTTP range request failed', {
        requestedRange,
        attempt,
        retryable,
        error: error?.message,
        code: error?.code,
        statusCode: error?.response?.status,
      });
      if (!retryable || attempt === HTTP_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(getRetryDelay(attempt));
    }
  }
}

function parseDigest(digest) {
  if (typeof digest !== 'string') {
    return null;
  }
  const [algorithm, value] = digest.split(':', 2);
  if (!algorithm || !value) {
    return null;
  }
  const normalizedAlgorithm = algorithm.toLowerCase();
  if (
    normalizedAlgorithm !== 'sha256' &&
    normalizedAlgorithm !== 'sha384' &&
    normalizedAlgorithm !== 'sha512'
  ) {
    return null;
  }
  return { algorithm: normalizedAlgorithm, value: value.toLowerCase() };
}

async function hashFile(filePath, algorithm) {
  return await new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyReleaseArtifact(
  artifactPath,
  expectedArtifact,
  logLabel = 'release artifact'
) {
  const stat = fs.statSync(artifactPath);
  if (
    Number.isFinite(expectedArtifact.size) &&
    expectedArtifact.size > 0 &&
    stat.size !== expectedArtifact.size
  ) {
    throw new Error(
      `${logLabel} size mismatch: expected ${expectedArtifact.size}, got ${stat.size}`
    );
  }

  const parsedDigest = parseDigest(expectedArtifact.digest);
  if (expectedArtifact.digest && !parsedDigest) {
    logUpdater('Invalid digest format, aborting verification', {
      artifactPath,
      logLabel,
      digest: expectedArtifact.digest,
    });
    throw new Error(
      `${logLabel} has invalid digest format: ${expectedArtifact.digest}`
    );
  }
  if (!parsedDigest) {
    logUpdater('No release digest available for artifact verification', {
      artifactPath,
      logLabel,
    });
    return;
  }

  const actualDigest = await hashFile(artifactPath, parsedDigest.algorithm);
  if (actualDigest !== parsedDigest.value) {
    throw new Error(
      `${logLabel} digest mismatch for ${parsedDigest.algorithm}`
    );
  }
}

async function verifyPatchedArtifact(
  outputArtifact,
  newFile,
  expectedArtifact,
  verifyLabel = 'Verifying patch',
  releaseTag
) {
  logUpdater('Verifying patched artifact metadata', {
    outputArtifact,
    releaseTag,
  });
  const stat = fs.statSync(outputArtifact);
  if (
    !Array.isArray(newFile.sizes) ||
    !Array.isArray(newFile.checksums) ||
    newFile.sizes.length !== newFile.checksums.length
  ) {
    throw new Error('Invalid blockmap payload for patched artifact');
  }
  const expectedByBlockmap =
    (newFile.offset || 0) +
    newFile.sizes.reduce((total, size) => total + size, 0);
  if (stat.size !== expectedByBlockmap) {
    throw new Error(
      `Patched artifact size mismatch: expected ${expectedByBlockmap}, got ${stat.size}`
    );
  }
  if (
    Number.isFinite(expectedArtifact.size) &&
    expectedArtifact.size > 0 &&
    stat.size !== expectedArtifact.size
  ) {
    throw new Error(
      `Patched artifact does not match expected release size ${expectedArtifact.size}`
    );
  }

  const fd = fs.openSync(outputArtifact, 'r');
  try {
    let readOffset = newFile.offset || 0;
    for (let i = 0; i < newFile.checksums.length; i++) {
      const size = newFile.sizes[i];
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`Invalid block size at index ${i}: ${size}`);
      }
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, readOffset);
      if (bytesRead !== size) {
        throw new Error(
          `Short read from patched artifact at ${readOffset}: expected ${size}, got ${bytesRead}`
        );
      }
      readOffset += size;
      if (
        i === newFile.checksums.length - 1 ||
        (i + 1) % VERIFY_PROGRESS_INTERVAL === 0
      ) {
        sendUpdaterStatus(
          verifyLabel,
          i + 1,
          newFile.checksums.length,
          releaseTag
        );
        await nextUiTick();
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  logUpdater('Completed block-level verification', {
    outputArtifact,
    releaseTag,
    blocks: newFile.checksums.length,
  });

  const parsedDigest = parseDigest(expectedArtifact.digest);
  if (!parsedDigest) {
    logUpdater('No release digest available for final artifact verification', {
      outputArtifact,
      releaseTag,
    });
    return;
  }
  const actualDigest = await hashFile(outputArtifact, parsedDigest.algorithm);
  if (actualDigest !== parsedDigest.value) {
    throw new Error(
      `Patched artifact digest mismatch for ${parsedDigest.algorithm}`
    );
  }
  logUpdater('Completed final artifact digest verification', {
    outputArtifact,
    releaseTag,
    algorithm: parsedDigest.algorithm,
  });
}

/**
 * Launches the installed OpenGameInstaller, rotating logs, spawning the platform-specific executable in a detached process, and terminating the updater.
 *
 * Spawns OpenGameInstaller with `--online=<online>` as an argument.
 * @param {boolean} online - If true, start the application in online mode; otherwise start in offline mode.
 */
async function launchApp(online) {
  const effectiveOnline = getEffectiveOnlineState(online).effectiveOnline;
  console.log(
    'Launching in ' + (effectiveOnline ? 'online' : 'offline') + ' mode'
  );
  mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
  if (process.platform === 'win32') {
    if (
      !fs.existsSync(path.join(__dirname, 'update', 'OpenGameInstaller.exe'))
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    // OpenGameInstaller.exe logs will be written to latest.log in the update directory
    // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
    if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
      fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
    }
    if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(
        path.join(__dirname, 'update', 'latest.log'),
        path.join(__dirname, 'update', 'logs', date + '.log')
      );
    }

    const logStream = fs.openSync(
      path.join(__dirname, 'update', 'latest.log'),
      'a'
    );
    const spawned = spawn(
      './OpenGameInstaller.exe',
      ['--online=' + effectiveOnline],
      {
        cwd: path.join(__dirname, 'update'),
        detached: true,
        stdio: ['ignore', logStream, logStream],
      }
    );
    spawned.unref();
    app.exit(0);
  } else if (process.platform === 'linux') {
    if (
      !fs.existsSync(
        path.join(__dirname, 'update', 'OpenGameInstaller.AppImage')
      )
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    setTimeout(() => {
      // OpenGameInstaller.AppImage logs will be written to latest.log in the update directory
      // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
      if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
        fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
      }
      if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(
          path.join(__dirname, 'update', 'latest.log'),
          path.join(__dirname, 'update', 'logs', date + '.log')
        );
      }
      const logStream = fs.openSync(
        path.join(__dirname, 'update', 'latest.log'),
        'a'
      );

      // --no-sandbox is needed to run the appimage in Steam Deck Game Mode
      const spawned = spawn(
        './OpenGameInstaller.AppImage',
        ['--online=' + effectiveOnline, '--no-sandbox'],
        {
          cwd: path.join(__dirname, 'update'),
          detached: true,
          stdio: ['ignore', logStream, logStream],
        }
      );
      spawned.unref();
      app.exit(0);
    }, 200);
  }
}

function resolveZipEntryPath(unzipToDir, entryName) {
  const root = path.resolve(unzipToDir);
  const normalizedEntryName = entryName.replace(/\//g, path.sep);
  const fullPath = path.resolve(root, normalizedEntryName);
  const relativePath = path.relative(root, fullPath);

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath === ''
  ) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }

  return fullPath;
}

app.on('ready', createWindow);
// taken from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
const unzip = (zipPath, unzipToDir) => {
  return new Promise<void>((resolve, reject) => {
    let zipFile = null;
    let filesProcessed = 0;
    let totalFiles = 0;
    logUpdater('Starting unzip', { zipPath, unzipToDir });

    try {
      // Create folder if not exists
      fs.mkdirSync(unzipToDir, { recursive: true });

      // Same as example we open the zip.
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err) {
          reject(err);
          return;
        }

        zipFile = zip;
        totalFiles = zipFile.entryCount;
        logUpdater('Opened zip archive', { zipPath, totalFiles });

        // This is the key. We start by reading the first entry.
        zipFile.readEntry();

        // Now for every entry, we will write a file or dir
        // to disk. Then call zipFile.readEntry() again to
        // trigger the next cycle.
        zipFile.on('entry', (entry) => {
          try {
            sendUpdaterStatus('Extracting Update', filesProcessed, totalFiles);
            const fullPath = resolveZipEntryPath(unzipToDir, entry.fileName);

            // Ensure the directory exists
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }

            // check if entry is a directory
            if (/\/$/.test(entry.fileName)) {
              filesProcessed++;
              sendUpdaterStatus(
                'Extracting Update',
                filesProcessed,
                totalFiles
              );
              if (filesProcessed >= totalFiles) {
                logUpdater('Completed unzip', {
                  zipPath,
                  unzipToDir,
                  totalFiles,
                });
                zipFile.close();
                resolve();
                return;
              }
              zipFile.readEntry();
              return;
            }

            // Files
            zipFile.openReadStream(entry, (readErr, readStream) => {
              if (readErr) {
                zipFile.close();
                reject(readErr);
                return;
              }

              const file = fs.createWriteStream(fullPath);
              readStream.pipe(file);

              file.on('finish', () => {
                // Wait until the file is finished writing, then read the next entry.
                file.close((closeErr) => {
                  if (closeErr) {
                    zipFile.close();
                    reject(closeErr);
                    return;
                  }

                  filesProcessed++;
                  sendUpdaterStatus(
                    'Extracting Update',
                    filesProcessed,
                    totalFiles
                  );
                  if (filesProcessed >= totalFiles) {
                    logUpdater('Completed unzip', {
                      zipPath,
                      unzipToDir,
                      totalFiles,
                    });
                    zipFile.close();
                    resolve();
                    return;
                  }
                  zipFile.readEntry();
                });
              });

              file.on('error', (fileErr) => {
                zipFile.close();
                reject(fileErr);
              });

              readStream.on('error', (streamErr) => {
                file.destroy();
                zipFile.close();
                reject(streamErr);
              });
            });
          } catch (e) {
            zipFile.close();
            reject(e);
          }
        });

        zipFile.on('end', () => {
          if (zipFile) {
            zipFile.close();
          }
          resolve();
        });

        zipFile.on('error', (zipErr) => {
          if (zipFile) {
            zipFile.close();
          }
          reject(zipErr);
        });
      });
    } catch (e) {
      if (zipFile) {
        zipFile.close();
      }
      reject(e);
    }
  });
};
