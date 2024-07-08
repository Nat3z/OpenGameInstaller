import OGIAddon from "ogi-addon";

const addon = new OGIAddon({
  name: 'test-addon',
  version: '1.0.0',
  author: 'OGI Developers',
  description: 'A test addon',
  repository: 'Repository URL'
});

addon.on('configure', (config) => config
  .addStringOption(option => option.setDisplayName('Test Option').setName('testOption').setDescription('A test option'))
  .addNumberOption(option => option.setDisplayName('Test Number Option').setName('testNumberOption').setDescription('A test number option'))
)