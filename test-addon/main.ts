import OGIAddon, { ConfigurationBuilder } from "ogi-addon";

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
      {
        name: "Direct Download Test",
        description: addon.config.getStringValue('testOption') || 'No description',
        coverURL: 'https://dummyimage.com/375x500/968d96/ffffff',
        appID: parseInt(text),
        storefront: 'steam',
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
    return;
  }
  addon.notify({ type: 'info', message: 'Searching...', id: 'search' });
});

addon.on('setup', ({ path, type, name, usedRealDebrid, steamAppID, multiPartFiles }, event) => {
  event.defer();
  event.log(`
path: ${path}
type: ${type}
name: ${name}
usedRealDebrid: ${usedRealDebrid}
multiPartFiles: ${multiPartFiles} 
  `)

  const waitForInput = event.askForInput('Please enter the code', 'code', 
    new ConfigurationBuilder()
      .addNumberOption(option => option.setDisplayName('Code').setName('code').setDescription('Enter the code').setMin(1).setMax(100))
  ).then((input) => {
    event.log(`Code: ${input.code}`);
    setTimeout(() => {
      event.resolve({
        cwd: path,
        capsuleImage: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppID}/library_600x900_2x.jpg`,
        launchExecutable: 'test.exe',
        name: name,
        steamAppID: steamAppID,
        version: '1.0.0'
      })
    }, 5000);
  });
});