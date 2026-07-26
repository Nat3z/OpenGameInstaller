import { chmodSync, cpSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import OGIAddon from 'ogi-addon';

const fixtureBaseUrl = process.env.OGI_FIXTURE_BASE_URL;
const fixtureElectronPath = process.env.OGI_FIXTURE_ELECTRON_PATH;
const fixtureGameMarkerPath = process.env.OGI_FIXTURE_GAME_MARKER_PATH;
const fixtureGameAutomationPort = process.env.OGI_FIXTURE_GAME_AUTOMATION_PORT;
const fixtureTorrentUrl = process.env.OGI_FIXTURE_TORRENT_URL;
if (!fixtureBaseUrl) throw new Error('OGI_FIXTURE_BASE_URL is required');
if (!fixtureElectronPath) {
  throw new Error('OGI_FIXTURE_ELECTRON_PATH is required');
}
if (!fixtureGameMarkerPath) {
  throw new Error('OGI_FIXTURE_GAME_MARKER_PATH is required');
}
if (!fixtureGameAutomationPort) {
  throw new Error('OGI_FIXTURE_GAME_AUTOMATION_PORT is required');
}

const game = {
  appID: 7001,
  storefront: 'ogi-e2e',
  name: 'Golden Journey Fixture',
  capsuleImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
};

const addon = new OGIAddon({
  id: 'ogi-e2e-fixture-addon',
  name: 'OGI E2E Fixture Addon',
  version: '1.0.0',
  author: 'OpenGameInstaller E2E',
  description:
    'Deterministic catalog and installation data for required E2E runs.',
  repository: '',
  storefronts: ['ogi-e2e'],
});

addon.on('configure', (configuration) => configuration);
addon.on('catalog', (event) => {
  event.resolve({
    sections: {
      goldenJourney: {
        name: 'Golden Journey',
        description: 'Deterministic games served by the Fixture Service',
        listings: [game],
      },
    },
  });
});
addon.on('game-details', (_request, event) => {
  event.resolve({
    ...game,
    basicDescription: 'A tiny deterministic game payload.',
    description: 'Used only by the packaged Golden Journey.',
    coverImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
    headerImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
    developers: ['OpenGameInstaller E2E'],
    publishers: ['OpenGameInstaller E2E'],
    releaseDate: '2026-01-01',
    latestVersion: '1.0.0',
  });
});
addon.on('search', (_request, event) => {
  if (fixtureTorrentUrl) {
    event.resolve([
      {
        name: 'Fixture Service local torrent',
        downloadType: 'torrent',
        downloadURL: fixtureTorrentUrl,
        manifest: {
          fixture: 'golden-journey',
          prerequisites: 'sandboxed',
          transport: 'loopback-torrent',
        },
      },
    ]);
    return;
  }
  event.resolve([
    {
      name: 'Fixture Service direct download',
      downloadType: 'direct',
      files: [
        {
          name: 'golden-journey.txt',
          downloadURL: `${fixtureBaseUrl}/games/golden-journey.txt`,
        },
        {
          name: 'fixture-game.cjs',
          downloadURL: `${fixtureBaseUrl}/games/fixture-game.cjs`,
        },
      ],
      manifest: { fixture: 'golden-journey', prerequisites: 'sandboxed' },
    },
  ]);
});
addon.on('setup', async ({ path, multiPartFiles }, event) => {
  if (fixtureTorrentUrl) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const fixtureMainPath = multiPartFiles?.find(
    (file) => file.name === 'fixture-game.cjs'
  )?.path;
  let installDirectory = fixtureMainPath ? dirname(fixtureMainPath) : path;
  if (fixtureTorrentUrl) {
    const stableInstallDirectory = resolve(path, '../../..', 'installed');
    cpSync(path, stableInstallDirectory, { recursive: true });
    installDirectory = stableInstallDirectory;
  }
  const launcherPath = join(
    installDirectory,
    process.platform === 'win32' ? 'fixture-game.cmd' : 'fixture-game.sh'
  );
  const electronPath = fixtureElectronPath.replaceAll('"', '\\"');
  const mainPath = join(installDirectory, 'fixture-game.cjs').replaceAll(
    '"',
    '\\"'
  );
  const markerPath = fixtureGameMarkerPath.replaceAll('"', '\\"');
  const launchArguments = [
    `--remote-debugging-port=${fixtureGameAutomationPort}`,
    `--marker=${markerPath}`,
  ];
  if (process.platform === 'win32') {
    writeFileSync(
      launcherPath,
      `@echo off\r\n"${electronPath}" "${mainPath}" ${launchArguments
        .map((argument) => `"${argument}"`)
        .join(' ')}\r\n`
    );
  } else {
    writeFileSync(
      launcherPath,
      `#!/bin/sh\nexec "${electronPath}" --no-sandbox "${mainPath}" ${launchArguments
        .map((argument) => `"${argument}"`)
        .join(' ')}\n`
    );
    chmodSync(launcherPath, 0o755);
  }
  event.resolve({
    cwd: installDirectory,
    installDirectory,
    launchExecutable: launcherPath,
    version: '1.0.0',
  });
});
addon.on('exit', () => process.exit(0));
