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
  .addStringOption(option => option.setDisplayName('Test Option').setName('testOption').setDescription('A test option').setMaxTextLength(100).setMinTextLength(1))
  .addStringOption(option => option.setDisplayName('Test Options').setName('testOptions').setDescription('A test option').setAllowedValues(['test1', 'test2', 'test3']).setDefaultValue('test1'))
  .addNumberOption(option => option.setDisplayName('Test Number Option').setName('testNumberOption').setDescription('A test number option').setMax(20))
  .addNumberOption(option => option.setDisplayName('Test Number Range Option').setName('testNumberRangeOption').setDescription('A test number option').setInputType("range").setMin(1).setMax(20))
  .addBooleanOption(option => option.setDisplayName('Test Boolean Option').setName('testBooleanOption').setDescription('A test boolean option'))
)
addon.on('connect', () => {
  addon.notify({ type: 'info', message: 'Connected', id: 'connect' });
})

addon.on('search', ({ text, type }, event) => {
  if (type === "steamapp") {
    event.resolve([
      // {
      //   name: "Dave The Diver",
      //   description: "A game about diving",
      //   coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      //   downloadSize: 100,
      //   steamAppID: 1868140,
      //   downloadType: 'direct',
      //   downloadURL: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
      // }
    ]);
    return;
  }
  addon.notify({ type: 'info', message: 'Searching...', id: 'search' });
  event.resolve([
    { 
      name: "Magnet Link Test",
      description: addon.config.getStringValue('testOption') || 'No description',
      coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      downloadSize: 100,
      downloadURL: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent',
      downloadType: 'magnet',
      filename: 'Big Buck Bunny'
    },
    {
      name: "Torrent Test",
      description: addon.config.getStringValue('testOption') || 'No description',
      coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      downloadURL: "https://webtorrent.io/torrents/tears-of-steel.torrent",
      downloadSize: 100,
      downloadType: 'torrent',
      filename: 'Tears of Steel'
    },
    {
      name: "Direct Download Test",
      description: addon.config.getStringValue('testOption') || 'No description',
      coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
      steamAppID: 1868140,
      downloadSize: 100,
      downloadType: 'direct',
      files: [
        {
          name: 'otherfile.zip',
          downloadURL: 'https://github.com/Nat3z/calendar-prod/archive/refs/heads/master.zip'
        },
        {
          name: 'file.zip',
          downloadURL: 'https://github.com/Nat3z/mc-discord-bot/archive/refs/heads/master.zip'
        }
      ]
    }
  ]);
});

addon.on('setup', ({ path, type, name, usedRealDebrid, multiPartFiles }, event) => {
  event.defer();
  event.log(`
path: ${path}
type: ${type}
name: ${name}
usedRealDebrid: ${usedRealDebrid}
multiPartFiles: ${multiPartFiles} 
  `)
  const inter = setInterval(() => {
    if (event.progress >= 100) {
      clearInterval(inter);
      event.complete();
      return
    }
    event.progress += 10;
  }, 1000)
});