import { Events, Library } from '@ogi-sdk/core';
import type { AppEvent, LibraryChange } from '@ogi-sdk/protocol';
import { Effect, Scope, Stream } from 'effect';
import { forkElectronEffect, runElectronSync } from '@/electron/runtime.js';

/**
 * Publishes an app event to core's `Events`. Protocol clients get it over
 * `events.watch`; the renderer gets it through {@link forwardEventsToRenderer}.
 * Synchronous, so events reach subscribers in the order they were published.
 */
export const publishEvent = (event: AppEvent): void => {
  runElectronSync(Effect.flatMap(Events, (events) => events.publish(event)));
};

type Ipc = readonly [channel: string, ...args: unknown[]];

/** The IPC channel and arguments the renderer has always listened for. */
const eventToIpc = (event: AppEvent): Ipc => {
  switch (event._tag) {
    case 'Notification':
      return [
        'notification',
        { id: event.id, type: event.level, message: event.message },
      ];
    case 'AddonsStarted':
      return ['all-addons-started'];
    case 'AddonManifestsReady':
      return ['addon-manifests-ready'];
    case 'AddonUpdateAvailable':
      return ['addon:update-available', event.addon];
    case 'AddonUpdated':
      return ['addon:updated', event.addon];
    case 'GameLaunchRequested':
      return ['game:launch-requested', { id: event.appID }];
    case 'GameLaunchFailed':
      return ['game:launch-error', { id: event.appID }];
    case 'Migration':
      return ['migration:event', event.name];
    case 'ShowChangelog':
      return ['app:show-changelog', event.version];
    case 'OobeLog':
      return ['oobe:log', event.line];
  }
};

/** Game lifecycle lives on the library feed; the renderer still wants it as events. */
const libraryToIpc = (change: LibraryChange): Ipc | undefined => {
  switch (change._tag) {
    // `managed`: core runs this session's hooks, so the renderer must not.
    case 'Launched':
      return ['game:launch', { id: change.appID, managed: change.managed }];
    case 'Exited':
      return ['game:exit', { id: change.appID, managed: change.managed }];
    default:
      return undefined;
  }
};

/**
 * Bridges core `Events` and the library's launch/exit changes to the
 * renderer's IPC channels, so the Svelte app keeps working unchanged while
 * every producer goes through core. Subscribes synchronously, so nothing
 * published after this call is missed. `send` waits for the renderer like
 * `sendIPCMessage` always has; one consumer per feed keeps events in order.
 * Removed once the renderer subscribes over the protocol.
 */
export const forwardEventsToRenderer = (
  send: (channel: string, ...args: unknown[]) => Promise<void>
): void => {
  // Lives as long as the process; the forked consumers are interrupted with
  // the runtime on quit.
  const scope = Effect.runSync(Scope.make());
  const deliver = (ipc: Ipc | undefined) =>
    ipc ? Effect.promise(() => send(...ipc)) : Effect.void;

  const events = runElectronSync(
    Effect.flatMap(Events, (service) => service.subscribe).pipe(
      Scope.extend(scope)
    )
  );
  const library = runElectronSync(
    Effect.flatMap(Library, (service) => service.changes).pipe(
      Scope.extend(scope)
    )
  );
  forkElectronEffect(
    Stream.fromQueue(events).pipe(
      Stream.runForEach((event) => deliver(eventToIpc(event)))
    )
  );
  forkElectronEffect(
    library.pipe(Stream.runForEach((change) => deliver(libraryToIpc(change))))
  );
};
