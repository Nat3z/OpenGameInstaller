import type {
  AddonClientToServerEventArgs,
  OGIAddonSDKEventListener,
} from '@ogi-sdk/connect';
import type { ConfigurationFile, StoreData } from '@ogi-sdk/connect';
import { DeferrableTask } from '../deffered';
import {
  closeProtocolError,
  getClientsSupporting,
  requireAuthenticated,
  requireMessageId,
} from './helpers';
import type { ClientMessageHandler, ClientMessageHandlers } from './types';

const handleNotification: ClientMessageHandler = ({ server }, message) => {
  server.emit(
    'notification',
    message.args as AddonClientToServerEventArgs['notification']
  );
};

const handleAuthenticate: ClientMessageHandler = (context, message) => {
  const { connection, config, server } = context;
  clearTimeout(context.authenticationTimeout);

  const authenticateArgs =
    message.args as AddonClientToServerEventArgs['authenticate'];
  connection.addonInfo = authenticateArgs;
  if (
    config.securityCheck &&
    (!authenticateArgs.secret || authenticateArgs.secret !== config.secret)
  ) {
    closeProtocolError(
      context,
      'Client attempted to authenticate with an invalid secret'
    );
    context.resolveAuthentication(false);
    return;
  }

  if (server.getClient(authenticateArgs.id)) {
    closeProtocolError(
      context,
      'Client attempted to authenticate with an ID that is already in use'
    );
    context.resolveAuthentication(false);
    return;
  }

  console.log('Client authenticated:', authenticateArgs.name);
  server.addClient(authenticateArgs.id, connection);
  context.resolveAuthentication(true);
};

const handleConfigure: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'config')) return;

  context.connection.configTemplate = message.args as ConfigurationFile;
};

const handleDeferUpdate: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'defer-update')) return;
  if (!message.args) return;

  const deferUpdateArgs =
    message.args as AddonClientToServerEventArgs['defer-update'];
  if (!deferUpdateArgs.deferID) {
    closeProtocolError(
      context,
      'Client attempted to send defer-update without an ID'
    );
    return;
  }

  const deferredTask = context.server.getDeferredTasksManager().getTasks()[
    deferUpdateArgs.deferID
  ];
  if (!deferredTask) {
    closeProtocolError(
      context,
      'Client attempted to send defer-update with an invalid ID'
    );
    return;
  }

  if (deferredTask.addonOwner !== context.connection.addonInfo!.id) return;
  deferredTask.logs = deferUpdateArgs.logs;
  deferredTask.progress = deferUpdateArgs.progress;
  if (deferUpdateArgs.failed) {
    deferredTask.failed = deferUpdateArgs.failed;
    deferredTask.finished = true;
  }
};

const handleInputAsked: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'input-asked')) return;
  if (!message.args) return;

  const inputAskedArgs =
    message.args as AddonClientToServerEventArgs['input-asked'];
  if (
    !inputAskedArgs.config ||
    !inputAskedArgs.name ||
    !inputAskedArgs.description
  ) {
    closeProtocolError(
      context,
      'Client attempted to send input-asked without a configuration'
    );
    return;
  }

  if (!requireMessageId(context, 'input-asked', message.id)) return;

  const configurationAsked = inputAskedArgs.config as
    | ConfigurationFile
    | undefined;
  const name = inputAskedArgs.name as string;
  const description = inputAskedArgs.description as string;
  if (!configurationAsked || !name || !description) {
    closeProtocolError(
      context,
      'Client attempted to send input-asked without a configuration'
    );
    return;
  }

  context.server.emit(
    'input-asked',
    name,
    description,
    configurationAsked,
    (reply: Record<string, string | number | boolean>) => {
      context.connection.events.response(message.id!, reply);
    }
  );
};

const handleTaskUpdate: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'task-update')) return;
  const taskUpdateArgs =
    message.args as AddonClientToServerEventArgs['task-update'];
  if (!taskUpdateArgs.id) {
    closeProtocolError(
      context,
      'Client attempted to send task-update without an ID'
    );
    return;
  }

  let task = context.server.getDeferredTasksManager().getTasks()[
    taskUpdateArgs.id
  ];

  if (!task) {
    task = new DeferrableTask(async () => {
      return null;
    }, context.connection.addonInfo!.id);
    task.id = taskUpdateArgs.id;
    context.server.getDeferredTasksManager().addTask(task);
  }

  task.progress = taskUpdateArgs.progress;
  task.logs = taskUpdateArgs.logs;
  task.finished = taskUpdateArgs.finished;
  task.failed = taskUpdateArgs.failed;

  if (taskUpdateArgs.failed) {
    task.finished = true;
    return;
  }

  if (taskUpdateArgs.finished && !taskUpdateArgs.failed) {
    context.server.getDeferredTasksManager().removeTask(taskUpdateArgs.id);
  }
};

const handleGetAppDetails: ClientMessageHandler = async (context, message) => {
  if (!requireAuthenticated(context, 'get-app-details')) return;
  if (!requireMessageId(context, 'get-app-details', message.id)) return;

  const { appID, storefront }: AddonClientToServerEventArgs['get-app-details'] =
    message.args as AddonClientToServerEventArgs['get-app-details'];
  const clientsWithStorefront = getClientsSupporting(
    context,
    storefront,
    'game-details'
  );

  let appDetails: StoreData | undefined;
  for (const client of clientsWithStorefront) {
    const response = await client.events.gameDetails({ appID, storefront });
    if (response.args) {
      appDetails = response.args as StoreData;
      break;
    }
  }

  if (!appDetails) {
    console.error('No app details found for client');
    context.connection.events.response(message.id, undefined);
    return;
  }

  context.connection.events.response(message.id, appDetails);
  console.log('Sent app details to client');
};

const handleSearchAppName: ClientMessageHandler = async (context, message) => {
  if (!requireAuthenticated(context, 'search-app-name')) return;
  if (!requireMessageId(context, 'search-app-name', message.id)) return;

  const { query, storefront }: AddonClientToServerEventArgs['search-app-name'] =
    message.args as AddonClientToServerEventArgs['search-app-name'];
  const clientsWithStorefront = getClientsSupporting(
    context,
    storefront,
    'library-search'
  );
  const searchResult: StoreData[] = [];

  for (const client of clientsWithStorefront) {
    const response = await client.events.librarySearch(query);
    if (response.args) {
      searchResult.push(...(response.args as StoreData[]));
    }
  }

  context.connection.events.response(message.id, searchResult);
};

const handleFlag: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'flag')) return;

  const flagArgs = message.args as AddonClientToServerEventArgs['flag'];
  if (flagArgs.flag === 'events-available') {
    console.log(
      'Setting events-available to',
      flagArgs.value,
      'for addon',
      context.connection.addonInfo!.id
    );
    context.connection.eventsAvailable =
      flagArgs.value as OGIAddonSDKEventListener[];
  }
};

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
