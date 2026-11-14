import { BunCommonCommands, defineConfig } from 'ogi-kit';

export default defineConfig({
  author: '{author}',
  compile: true,
  addons: [], // insert any pre-requisite dependencies for your addon when developing
  scripts: {
    run: BunCommonCommands.RunScript('./main.ts'),
    setup: BunCommonCommands.InstallFrozenDependencies,
  },
  iconPath: './favicon.png',
  ignoredWatchFiles: [],
});
