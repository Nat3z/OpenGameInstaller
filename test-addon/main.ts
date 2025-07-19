import OGIAddon, { ConfigurationBuilder } from 'ogi-addon';

const addon = new OGIAddon({
  name: 'test-addon',
  version: '1.0.0',
  id: 'test-addon',

  author: 'OGI Developers',
  description: 'A test addon',
  repository: 'Repository URL',
});

addon.on('configure', (config) =>
  config
    .addStringOption((option) =>
      option
        .setDisplayName('Test Option')
        .setName('testOption')
        .setDescription('A test option')
        .setMaxTextLength(100)
        .setMinTextLength(1)
        .setDefaultValue('Test Value')
    )
    .addStringOption((option) =>
      option
        .setDisplayName('Test Options')
        .setName('testOptions')
        .setDescription('A test option')
        .setAllowedValues(['test1', 'test2', 'test3'])
        .setDefaultValue('test1')
    )
    .addNumberOption((option) =>
      option
        .setDisplayName('Test Number Option')
        .setName('testNumberOption')
        .setDescription('A test number option')
        .setMax(20)
    )
    .addNumberOption((option) =>
      option
        .setDisplayName('Test Number Range Option')
        .setName('testNumberRangeOption')
        .setDescription('A test number option')
        .setInputType('range')
        .setMin(1)
        .setMax(20)
    )
    .addBooleanOption((option) =>
      option
        .setDisplayName('Test Boolean Option')
        .setName('testBooleanOption')
        .setDescription('A test boolean option')
    )
);
addon.on('connect', () => {
  addon.notify({ type: 'info', message: 'Connected', id: 'connect' });
  new Promise(async (resolve) => {
    const task = await addon.task();
    task.log('test');
    task.setProgress(1);
    setTimeout(() => {
      task.log('test 1');
      task.setProgress(50);
    }, 3000);
    setTimeout(() => {
      task.log('test 2');
      task.setProgress(100);
    }, 5000);
    setTimeout(() => {
      task.finish();
    }, 10000);
  });
  new Promise(async (resolve) => {
    const task = await addon.task();
    task.log('test');
    task.setProgress(1);
    setTimeout(() => {
      task.log('test 1');
    }, 3000);
    task.fail('expected failure');
    return;
  });
});

addon.on('request-dl', (appID, info, event) => {
  event.defer();

  event.log(
    `Requesting download for ${appID} with info: ${JSON.stringify(info)}`
  );
  // setTimeout(() => {
  //   event.resolve({
  //     ...info,
  //     downloadType: 'magnet',
  //     downloadURL: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent'
  //   })
  // }, 5000);
  setTimeout(() => {
    event.fail('expected failure');
  }, 5000);
});

addon.on('exit', () => {
  console.log('Exiting');
  process.exit(0);
});

addon.on('search', ({ text, type }, event) => {
  event.defer();
  new Promise(async (resolve) => {
    if (type === 'internal' || type === 'steamapp') {
      console.log(text);
      const results = await addon.steamSearch(text, true);
      event.resolve([
        {
          name: 'Magnet Test',
          storefront: 'steam',
          downloadType: 'magnet',
          filename: 'Big Buck Bunny.mp4',
          downloadURL:
            'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent',
        },
        {
          name: 'Direct Download Test',
          storefront: 'steam',
          downloadType: 'request',
          filename: 'Big Buck Bunny',
        },
        {
          name: 'Smaller File',
          storefront: 'steam',
          filename: 'Smaller File.txt',
          downloadType: 'direct',
          downloadURL: 'https://ogi.nat3z.com/api/community.json',
        },
      ]);
      addon.notify({ type: 'info', message: 'Searching...', id: 'search' });
    }
  });
});

addon.on(
  'setup',
  (
    { path, type, name, usedRealDebrid, appID, storefront, multiPartFiles },
    event
  ) => {
    event.defer();
    event.log(`
path: ${path}
type: ${type}
name: ${name}
usedRealDebrid: ${usedRealDebrid}
multiPartFiles: ${multiPartFiles} 
  `);

    const waitForInput = event
      .askForInput(
        'Please enter the code',
        'code',
        new ConfigurationBuilder().addNumberOption((option) =>
          option
            .setDisplayName('Code')
            .setName('code')
            .setDescription('Enter the code')
            .setMin(1)
            .setMax(100)
        )
      )
      .then((input) => {
        event.log(`Code: ${input.code}`);
        console.log(input.code, input.code === 50);
        if (Number(input.code) === 50) {
          process.exit(1);
        }
        setTimeout(() => {
          event.resolve({
            cwd: path,
            capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
            coverImage: 'https://dummyimage.com/375x500/968d96/ffffff',
            launchExecutable: 'test.exe',
            name: name,
            appID: appID,
            storefront: 'internal',
            addonsource: 'test-addon',
            version: '1.0.0',
          });
        }, 5000);
      });
  }
);

addon.on('library-search', (text, event) => {
  event.resolve([
    {
      appID: 1,
      capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      name: 'Test App',
    },
  ]);
});

addon.on('game-details', (appID, event) => {
  event.resolve({
    appID: appID,
    basicDescription: 'The Coolest Test App',
    capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
    description: '<script>alert("hello world")</script><h1>hello world</h1>',
    coverImage: 'https://dummyimage.com/375x500/968d96/ffffff',
    name: 'Test App',
    developers: ['OGI Developers'],
    headerImage: 'https://dummyimage.com/500x350/968d96/ffffff',
    publishers: ['OGI Developers'],
    releaseDate: new Date().toISOString(),
  });
});
