import type {
  ClientSentEventTypes,
  Notification,
  OGIAddonConfiguration,
  OGIAddonEvent,
  StoreData,
} from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import { DeferrableTask } from '../deffered';
import {
  closeProtocolError,
  getClientsSupporting,
  requireAuthenticated,
  requireMessageId,
} from './helpers';
import type { ClientMessageHandler, ClientMessageHandlers } from './types';

const handleNotification: ClientMessageHandler = ({ server }, message) => {
  server.emit('notification', message.args[0] as Notification);
};

const handleAuthenticate: ClientMessageHandler = (context, message) => {
  const { connection, config, server } = context;
  clearTimeout(context.authenticationTimeout);

  const addonInfo = message.args as OGIAddonConfiguration;
  connection.addonInfo = addonInfo;
  if (
    config.securityCheck &&
    (!message.args.secret || message.args.secret !== config.secret)
  ) {
    closeProtocolError(
      context,
      'Client attempted to authenticate with an invalid secret'
    );
    context.resolveAuthentication(false);
    return;
  }

  if (server.getClient(addonInfo.id)) {
    closeProtocolError(
      context,
      'Client attempted to authenticate with an ID that is already in use'
    );
    context.resolveAuthentication(false);
    return;
  }

  console.log('Client authenticated:', message.args.name);
  server.addClient(addonInfo.id, connection);
  context.resolveAuthentication(true);
};

const handleConfigure: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'config')) return;

  context.connection.configTemplate = message.args;
};

const handleDeferUpdate: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'defer-update')) return;
  if (!message.args) return;

  if (!message.args.deferID) {
    closeProtocolError(
      context,
      'Client attempted to send defer-update without an ID'
    );
    return;
  }

  const deferredTask = context.server.getDeferredTasksManager().getTasks()[
    message.args.deferID
  ];
  if (!deferredTask) {
    closeProtocolError(
      context,
      'Client attempted to send defer-update with an invalid ID'
    );
    return;
  }

  if (deferredTask.addonOwner !== context.connection.addonInfo!.id) return;
  deferredTask.logs = message.args.logs;
  deferredTask.progress = message.args.progress;
  if (message.args.failed) {
    deferredTask.failed = message.args.failed;
    deferredTask.finished = true;
  }
};

const handleInputAsked: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'input-asked')) return;
  if (!message.args) return;

  if (!message.args.config || !message.args.name || !message.args.description) {
    closeProtocolError(
      context,
      'Client attempted to send input-asked without a configuration'
    );
    return;
  }

  if (!requireMessageId(context, 'input-asked', message.id)) return;

  const configurationAsked = message.args.config as
    | ConfigurationFile
    | undefined;
  const name = message.args.name as string;
  const description = message.args.description as string;
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
  if (!message.args.id) {
    closeProtocolError(
      context,
      'Client attempted to send task-update without an ID'
    );
    return;
  }

  const taskUpdate = message.args as ClientSentEventTypes['task-update'];
  let task = context.server.getDeferredTasksManager().getTasks()[
    message.args.id
  ];

  if (!task) {
    task = new DeferrableTask(async () => {
      return null;
    }, context.connection.addonInfo!.id);
    task.id = taskUpdate.id;
    context.server.getDeferredTasksManager().addTask(task);
  }

  task.progress = taskUpdate.progress;
  task.logs = taskUpdate.logs;
  task.finished = taskUpdate.finished;
  task.failed = taskUpdate.failed;

  if (taskUpdate.failed) {
    task.finished = true;
    return;
  }

  if (taskUpdate.finished && !taskUpdate.failed) {
    context.server.getDeferredTasksManager().removeTask(message.args.id);
  }
};

const handleGetAppDetails: ClientMessageHandler = async (context, message) => {
  if (!requireAuthenticated(context, 'get-app-details')) return;
  if (!requireMessageId(context, 'get-app-details', message.id)) return;

  const { appID, storefront }: ClientSentEventTypes['get-app-details'] =
    message.args;
  const clientsWithStorefront = getClientsSupporting(
    context,
    storefront,
    'game-details'
  );

  let appDetails: StoreData | undefined;
  for (const client of clientsWithStorefront) {
    const response = await client.events.gameDetails({ appID, storefront });
    if (response.args) {
      appDetails = response.args;
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

  const { query, storefront }: ClientSentEventTypes['search-app-name'] =
    message.args;
  const clientsWithStorefront = getClientsSupporting(
    context,
    storefront,
    'library-search'
  );
  const searchResult: StoreData[] = [];

  for (const client of clientsWithStorefront) {
    const response = await client.events.librarySearch(query);
    if (response.args) {
      searchResult.push(...response.args);
    }
  }

  context.connection.events.response(message.id, searchResult);
};

const handleFlag: ClientMessageHandler = (context, message) => {
  if (!requireAuthenticated(context, 'flag')) return;

  if (message.args.flag === 'events-available') {
    console.log(
      'Setting events-available to',
      message.args.value,
      'for addon',
      context.connection.addonInfo!.id
    );
    context.connection.eventsAvailable = message.args.value as OGIAddonEvent[];
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
