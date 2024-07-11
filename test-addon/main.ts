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
      downloadURL: 'https://eu-cdn.moriyashrine.org/monthly_2022_05/1856062793_Touhou8-ImperishableNight.zip_torrent.0b35d728a68acbae0c92f7133a3f1648?X-Amz-Expires=1200&response-content-disposition=filename=%22Touhou%25208%2520-%2520Imperishable%2520Night.zip.torrent%22&response-content-type=application/x-unknown;charset=UTF-8',
      downloadType: 'real-debrid-torrent'
    }]);
  }, 2000);
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