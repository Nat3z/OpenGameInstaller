import OGIAddon from 'ogi-addon';

const addon = new OGIAddon({
  name: '{addon-name}',
  version: '1.0.0',
  id: '{addon-id}',

  author: '{author}',
  description: 'Your addon description',
  repository: 'Repository URL',
  storefronts: ['steam'],
});

addon.on('configure', (config) => config);

addon.on('connect', () => {});

addon.on('disconnect', () => {
  process.exit(0);
});
