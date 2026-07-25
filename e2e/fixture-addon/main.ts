import OGIAddon from 'ogi-addon';

const fixtureBaseUrl = process.env.OGI_FIXTURE_BASE_URL;
if (!fixtureBaseUrl) {
  throw new Error('OGI_FIXTURE_BASE_URL is required');
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
  event.resolve([
    {
      name: 'Fixture Service direct download',
      downloadType: 'direct',
      files: [
        {
          name: 'golden-journey.txt',
          downloadURL: `${fixtureBaseUrl}/games/golden-journey.txt`,
        },
      ],
      manifest: { fixture: 'golden-journey', prerequisites: 'sandboxed' },
    },
  ]);
});
addon.on('setup', ({ path }, event) => {
  event.resolve({
    cwd: path,
    launchExecutable: 'golden-journey.txt',
    version: '1.0.0',
  });
});
addon.on('exit', () => process.exit(0));
