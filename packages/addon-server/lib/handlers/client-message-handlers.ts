import type {
  AddonClientToServerEventArgs,
  AddonNotificationMessage,
  ConfigurationFile,
  OGIAddonSDKEventListener,
  StoreData,
} from '@ogi-sdk/connect';
import { Effect } from 'effect';
import { DeferrableTask } from '../deffered';
import {
  closeProtocolError,
  getClientsSupporting,
  requireAuthenticated,
  requireMessageId,
} from './helpers';
import type { ClientMessageHandler, ClientMessageHandlers } from './types';

const handleNotification: ClientMessageHandler = ({ server }, message) => {
  const args = message.args as AddonClientToServerEventArgs['notification'];
  const notification: AddonNotificationMessage | undefined = Array.isArray(args)
    ? args[0]
    : args;
  return notification?.type && notification.message
    ? server.emitEffect('notification', notification)
    : Effect.void;
};

const handleAuthenticate: ClientMessageHandler = (context, message) =>
  Effect.gen(function* () {
    const { connection, config, server } = context;
    const args = message.args as AddonClientToServerEventArgs['authenticate'];
    if (
      config.securityCheck &&
      (!args.secret || args.secret !== config.secret)
    ) {
      closeProtocolError(
        context,
        'Client attempted to authenticate with an invalid secret'
      );
      yield* context.resolveAuthentication(false);
      return;
    }
    if (server.getClient(args.id)) {
      closeProtocolError(
        context,
        'Client attempted to authenticate with an ID that is already in use'
      );
      yield* context.resolveAuthentication(false);
      return;
    }
    yield* Effect.sync(() => {
      connection.addonInfo = args;
      console.log('Client authenticated:', args.name);
      server.addClient(args.id, connection);
    });
    yield* context.resolveAuthentication(true);
  });

const handleConfigure: ClientMessageHandler = (context, message) =>
  Effect.sync(() => {
    if (requireAuthenticated(context, 'config')) {
      context.connection.configTemplate = message.args as ConfigurationFile;
    }
  });

const handleDeferUpdate: ClientMessageHandler = (context, message) =>
  Effect.sync(() => {
    if (!requireAuthenticated(context, 'defer-update') || !message.args) return;
    const args = message.args as AddonClientToServerEventArgs['defer-update'];
    if (!args.deferID) {
      closeProtocolError(
        context,
        'Client attempted to send defer-update without an ID'
      );
      return;
    }
    const task = context.server.getDeferredTasksManager().getTasks()[
      args.deferID
    ];
    if (!task) {
      closeProtocolError(
        context,
        'Client attempted to send defer-update with an invalid ID'
      );
      return;
    }
    if (task.addonOwner !== context.connection.addonInfo!.id) return;
    task.logs = args.logs;
    task.progress = args.progress;
    if (args.failed) {
      task.failed = args.failed;
      task.finished = true;
    }
  });

const handleInputAsked: ClientMessageHandler = (context, message) =>
  Effect.gen(function* () {
    if (!requireAuthenticated(context, 'input-asked') || !message.args) return;
    const args = message.args as AddonClientToServerEventArgs['input-asked'];
    if (!args.config || !args.name || !args.description) {
      closeProtocolError(
        context,
        'Client attempted to send input-asked without a configuration'
      );
      return;
    }
    if (!requireMessageId(context, 'input-asked', message.id)) return;
    yield* context.server.emitEffect(
      'input-asked',
      args.name,
      args.description,
      args.config,
      (reply) =>
        Effect.runPromise(
          context.connection.events
            .response(message.id!, reply)
            .pipe(Effect.asVoid)
        )
    );
  });

const handleTaskUpdate: ClientMessageHandler = (context, message) =>
  Effect.gen(function* () {
    if (!requireAuthenticated(context, 'task-update')) return;
    const args = message.args as AddonClientToServerEventArgs['task-update'];
    if (!args.id) {
      closeProtocolError(
        context,
        'Client attempted to send task-update without an ID'
      );
      return;
    }
    const manager = context.server.getDeferredTasksManager();
    let task = manager.getTasks()[args.id];
    if (!task) {
      task = new DeferrableTask(
        () => Effect.succeed(null),
        context.connection.addonInfo!.id
      );
      task.id = args.id;
      yield* manager.addTask(task);
    }
    task.progress = args.progress;
    task.logs = args.logs;
    task.finished = args.finished;
    task.failed = args.failed;
    if (args.failed) task.finished = true;
  });

const handleGetAppDetails: ClientMessageHandler = (context, message) =>
  Effect.gen(function* () {
    if (!requireAuthenticated(context, 'get-app-details')) return;
    if (!requireMessageId(context, 'get-app-details', message.id)) return;
    const { appID, storefront } =
      message.args as AddonClientToServerEventArgs['get-app-details'];
    const clients = getClientsSupporting(context, storefront, 'game-details');
    let appDetails: StoreData | undefined;
    for (const client of clients) {
      const response = yield* client.events.gameDetails({ appID, storefront });
      if (response.args) {
        appDetails = response.args as StoreData;
        break;
      }
    }
    if (!appDetails) console.error('No app details found for client');
    yield* context.connection.events
      .response(message.id, appDetails)
      .pipe(Effect.asVoid);
  });

const handleSearchAppName: ClientMessageHandler = (context, message) =>
  Effect.gen(function* () {
    if (!requireAuthenticated(context, 'search-app-name')) return;
    if (!requireMessageId(context, 'search-app-name', message.id)) return;
    const { query, storefront } =
      message.args as AddonClientToServerEventArgs['search-app-name'];
    const clients = getClientsSupporting(context, storefront, 'library-search');
    const results: StoreData[] = [];
    for (const client of clients) {
      const response = yield* client.events.librarySearch(query);
      if (response.args) results.push(...(response.args as StoreData[]));
    }
    yield* context.connection.events
      .response(message.id, results)
      .pipe(Effect.asVoid);
  });

const handleFlag: ClientMessageHandler = (context, message) =>
  Effect.sync(() => {
    if (!requireAuthenticated(context, 'flag')) return;
    const args = message.args as AddonClientToServerEventArgs['flag'];
    if (args.flag === 'events-available') {
      context.connection.eventsAvailable =
        args.value as OGIAddonSDKEventListener[];
    }
  });

export const createClientMessageHandlers = (): ClientMessageHandlers => ({
  notification: handleNotification,
  authenticate: handleAuthenticate,
  configure: handleConfigure,
  'defer-update': handleDeferUpdate,
  'input-asked': handleInputAsked,
  'task-update': handleTaskUpdate,
  'get-app-details': handleGetAppDetails,
  'search-app-name': handleSearchAppName,
  flag: handleFlag,
});
