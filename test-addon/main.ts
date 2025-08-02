import OGIAddon, { ConfigurationBuilder } from 'ogi-addon';

const addon = new OGIAddon({
  name: 'Test Addon',
  version: '1.0.0',
  id: 'test-addon',

  author: 'OGI Developers',
  description: 'A test addon',
  repository: 'Repository URL',
  storefronts: ['test-front', 'steam'],
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

addon.on('task-run', ({ manifest, name, downloadPath }, event) => {
  event.defer();
  event.log(`Running task ${name} with manifest ${JSON.stringify(manifest)}`);
  event.log(`Download path: ${downloadPath}`);
  new Promise(async (resolve) => {
    // keep incrementing the progress every 1 second
    const input = await event.askForInput(
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
    );
    if (input.code === 100) {
      event.fail('Code is 100');
      return;
    }
    const interval = setInterval(() => {
      if (event.progress >= 100) {
        clearInterval(interval);
        console.log('Task completed');
        event.resolve();
        return;
      }
      event.progress += 10;
      event.log(`Progress: ${event.progress}`);
    }, 1000);
  });
});

addon.on('search', ({ storefront, appID, for: searchFor }, event) => {
  event.defer();
  if (searchFor === 'game') {
    addon.notify({ type: 'info', message: 'Searching...', id: 'search' });
  }
  new Promise(async (resolve) => {
    console.log(appID);
    event.resolve([
      {
        name: 'Magnet Test',
        downloadType: 'magnet',
        filename: 'Big Buck Bunny',
        downloadURL:
          'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent',
      },
      {
        name: 'Task Test',
        downloadType: 'task',
        manifest: {
          test: 'Task Test',
        },
      },
      {
        name: 'Direct Download Test',
        downloadType: 'request',
        filename: 'Big Buck Bunny',
      },
      {
        name: 'Smaller File',
        downloadType: 'direct',
        files: [
          {
            name: 'Smaller File.txt',
            downloadURL: 'https://ogi.nat3z.com/api/community.json',
            headers: {
              'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
              'X-Hello': 'World',
            },
          },
        ],
        manifest: {
          t: 'Smalelr File',
        },
      },
    ]);
  });
});
addon.on(
  'setup',
  (
    {
      path,
      type,
      name,
      usedRealDebrid,
      appID,
      storefront,
      multiPartFiles,
      manifest,
    },
    event
  ) => {
    event.defer();
    event.log(`
path: ${path}
type: ${type}
name: ${name}
usedRealDebrid: ${usedRealDebrid}
multiPartFiles: ${multiPartFiles} 
manifest: ${manifest}
  `);
    console.log('oo hello!');
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
            launchExecutable: 'Big Buck Bunny.mp4',
            launchArguments: 'open %command%',
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
      name: 'Test: App',
      storefront: 'test-front',
    },
  ]);
});

addon.on('game-details', ({ appID, storefront }, event) => {
  if (appID === 1) {
    event.resolve({
      appID: appID,
      basicDescription: 'The Coolest Test App',
      capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      description: '<script>alert("hello world")</script><h1>hello world</h1>',
      coverImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      name: 'Test: App',
      developers: ['OGI Developers'],
      headerImage: 'https://dummyimage.com/500x350/968d96/ffffff',
      publishers: ['OGI Developers'],
      releaseDate: new Date().toISOString(),
    });
    return;
  }
  event.resolve(undefined);
});

addon.on('catalog', (event) => {
  // for testing purposes, we will ask for gameDetails for the test app 1
  event.defer();
  new Promise(async (resolve) => {
    const details = (await addon.getAppDetails(1, 'test-front'))!;
    event.resolve({
      x: {
        name: 'Test Catalog',
        description: 'A test catalog',
        listings: [
          {
            appID: details.appID,
            name: details.name,
            capsuleImage: details.capsuleImage,
            storefront: 'test-front',
          },
          {
            appID: 945360,
            name: 'Among Us',
            capsuleImage:
              'https://steamcdn-a.akamaihd.net/steam/apps/945360/library_600x900_2x.jpg',
            storefront: 'steam',
          },
        ],
      },
      cat: {
        name: 'Among Us',
        description: 'The best Among Us',
        listings: [
          {
            appID: 945360,
            name: 'Among Us',
            capsuleImage:
              'https://steamcdn-a.akamaihd.net/steam/apps/945360/library_600x900_2x.jpg',
            storefront: 'steam',
          },
        ],
      },
    });
  });
});
