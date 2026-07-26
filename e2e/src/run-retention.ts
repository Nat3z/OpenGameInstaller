import {
  applyRunRetention,
  getDefaultRunRoot,
  pinRetainedRun,
} from './run-reliability';

const [command, path] = process.argv.slice(2);

switch (command) {
  case 'pin':
  case 'unpin': {
    if (!path)
      throw new Error(
        `Usage: bun run src/run-retention.ts ${command} <sandbox>`
      );
    const manifest = pinRetainedRun(path, command === 'pin');
    console.log(
      `${manifest.runId}: ${manifest.pinned ? 'pinned' : 'unpinned'}`
    );
    break;
  }
  case 'prune': {
    const result = applyRunRetention(path ?? getDefaultRunRoot());
    console.log(`Retained runs kept: ${result.kept.length}`);
    console.log(`Expired runs deleted: ${result.deleted.length}`);
    break;
  }
  default:
    throw new Error(
      'Usage: bun run src/run-retention.ts pin <sandbox> | unpin <sandbox> | prune [root]'
    );
}
