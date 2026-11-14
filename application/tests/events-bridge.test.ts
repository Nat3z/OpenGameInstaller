import { expect, mock, test } from 'bun:test';
import { Effect } from 'effect';

// The real runtime opens the database lazily, and only through `electron`.
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// The renderer still listens on the old IPC channels. Whatever goes through
// core must come out on the same channel, with the same payload, in order.
test('core events and game lifecycle reach the renderer unchanged', async () => {
  const { forwardEventsToRenderer, publishEvent } = await import(
    '../src/electron/server/events-bridge.js'
  );
  const { runElectronSync } = await import('../src/electron/runtime.js');
  const { Library } = await import('../src/electron/services/index.js');

  const sent: unknown[][] = [];
  const done = Promise.withResolvers<void>();
  forwardEventsToRenderer(async (...ipc) => {
    sent.push(ipc);
    if (sent.length === 5) done.resolve();
  });

  publishEvent({
    _tag: 'Notification',
    id: 'n1',
    level: 'success',
    message: 'Installed',
  });
  publishEvent({ _tag: 'AddonUpdateAvailable', addon: 'git@a/b' });
  publishEvent({ _tag: 'AddonsStarted' });
  publishEvent({ _tag: 'ShowChangelog', version: '2.5.0' });
  runElectronSync(Effect.flatMap(Library, (l) => l.notifyLaunched(7)));
  await done.promise;

  // Library changes arrive on their own feed, so only order within a feed is
  // guaranteed; the events feed must be exactly in publish order.
  expect(sent.filter(([channel]) => channel !== 'game:launch')).toEqual([
    ['notification', { id: 'n1', type: 'success', message: 'Installed' }],
    ['addon:update-available', 'git@a/b'],
    ['all-addons-started'],
    ['app:show-changelog', '2.5.0'],
  ]);
  expect(sent).toContainEqual(['game:launch', { id: 7 }]);
});
