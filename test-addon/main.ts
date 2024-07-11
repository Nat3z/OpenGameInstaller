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
  event.resolve([{ 
    name: "Real Debrid Test",
    description: addon.config.getStringValue('testOption') || 'No description',
    coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
    downloadSize: 100,
    downloadURL: 'https://real-debrid.com/d/O4GZCDAA73QEQFB5',
    downloadType: 'real-debrid-magnet'
  },
  {
    name: "Torrent Test",
    description: addon.config.getStringValue('testOption') || 'No description',
    coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
    downloadSize: 100,
    downloadType: 'real-debrid-torrent'
  }]);
});

addon.on('setup', (path, event) => {
  event.defer();
  const inter = setInterval(() => {
    if (event.progress >= 100) {
      clearInterval(inter);
      event.complete();
      return
    }
    event.progress += 10;
    event.log("Setting up...")
  }, 1000)
});