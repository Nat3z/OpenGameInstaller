import OGIAddon from "ogi-addon";

const addon = new OGIAddon({
  name: 'test-addon',
  version: '1.0.0',
  id: 'test-addon',

  author: 'OGI Developers',
  description: 'A test addon',
  repository: 'Repository URL'
});

addon.on('configure', (config) => config
  .addStringOption(option => option.setDisplayName('Test Option').setName('testOption').setDescription('A test option').setMaxTextLength(100))
  .addNumberOption(option => option.setDisplayName('Test Number Option').setName('testNumberOption').setDescription('A test number option').setMax(20))
  .addBooleanOption(option => option.setDisplayName('Test Boolean Option').setName('testBooleanOption').setDescription('A test boolean option'))
)

addon.on('search', (query, event) => {
  event.defer();
  setTimeout(() => {
    event.resolve([{ 
      name: query,
      description: addon.config.getStringValue('testOption') || 'No description',
      coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      downloadSize: 100,
      downloadURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      downloadType: 'direct'
    }]);
  }, 2000);
});