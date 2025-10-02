import OGIAddon, { ConfigurationBuilder } from 'ogi-addon';

const addon = new OGIAddon({
  name: 'Test Addon',
  version: '1.0.0',
  id: 'test-addon',

  author: 'OGI Developers',
  description: 'A test addon',
  repository: 'Repository URL',
  storefronts: ['test-front'],
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
      {
        name: 'Multi-Part Test',
        downloadType: 'direct',
        files: [
          {
            name: '100MB File',
            downloadURL: 'https://ash-speed.hetzner.com/100MB.bin',
          },
          {
            name: '1GB File',
            downloadURL: 'https://ash-speed.hetzner.com/1GB.bin',
          },
          {
            name: '10GB File',
            downloadURL: 'https://ash-speed.hetzner.com/10GB.bin',
          },
        ],
      },
      {
        name: 'Failer Test',
        downloadType: 'direct',
        files: [
          {
            name: 'Failer File',
            downloadURL: 'http://localhost:3000',
          },
        ],
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
  if (text === 'test app') {
    addon.notify({ type: 'info', message: 'Searching...', id: 'search' });
    event.defer(async () => {
      event.resolve([(await addon.searchGame('among us', 'steam'))[0]]);
    });
    return;
  }
  event.resolve([
    {
      appID: 1,
      capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      name: text,
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

// Bun Serve Test
Bun.serve({
  port: 10572,
  fetch: async (req) => {
    const filePath = './test.txt';
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response('File not found', { status: 404 });
      }

      // Get file size
      const stat = await file.stat();
      if (!stat) {
        return new Response('File not found', { status: 404 });
      }
      const totalSize = stat.size;
      const halfSize = Math.floor(totalSize / 2);

      // Parse Range header if present
      const rangeHeader = req.headers.get('range') || req.headers.get('Range');
      let start = 0;
      let end = totalSize - 1;
      let isRangeRequest = false;

      if (rangeHeader) {
        // Example: "bytes=100-"
        const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
        if (match) {
          start = parseInt(match[1], 10);
          if (match[2]) {
            end = Math.min(parseInt(match[2], 10), totalSize - 1);
          }
          isRangeRequest = true;
        }
      }

      // If this is a retry (Range request starting after 50%), allow full stream
      if (isRangeRequest && start >= halfSize) {
        // Serve the rest of the file as normal
        const stream = file.stream();
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Type': 'text/plain',
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': (end - start + 1).toString(),
          },
        });
      }

      // Otherwise, fail after 50% downloaded
      const origStream = file.stream();
      let bytesSent = start;
      let failed = false;

      const failingStream = new ReadableStream({
        start(controller) {
          const reader = origStream.getReader();

          function push() {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  if (!failed) controller.close();
                  return;
                }
                if (failed) return; // Already failed, do nothing

                bytesSent += value.length;
                // Only fail if we cross 50% and it's not a retry past 50%
                if (bytesSent + start > halfSize && !failed) {
                  failed = true;
                  controller.error(new Error('Simulated failure after 50%'));
                  reader.cancel();
                  return;
                }
                controller.enqueue(value);
                push();
              })
              .catch((err) => {
                controller.error(err);
              });
          }
          push();
        },
      });

      // If this is a range request, respond with 206
      const responseHeaders: Record<string, string> = {
        'Content-Type': 'text/plain',
        'Accept-Ranges': 'bytes',
      };
      if (isRangeRequest) {
        responseHeaders['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
        responseHeaders['Content-Length'] = (end - start + 1).toString();
      }

      return new Response(failingStream, {
        status: isRangeRequest ? 206 : 200,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response('Internal Server Error', { status: 500 });
    }
  },
});
