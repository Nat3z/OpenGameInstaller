import { readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import {
  type AddonClientSDKToServerIncomingMessage,
  type AddonClientSDKToServerWebsocketMessage,
  type AddonNotificationMessage,
  type AddonServerToClientEventArgs,
  type AddonServerToClientEventName,
  type AddonServerToClientSDKIncomingMessage,
  type AddonServerToClientSDKWebsocketMessage,
  type ConfigurationFile,
  type ConnectedAddonInfo,
  EventResponseSocket,
  type SDKRequestName,
  type SDKResponse,
  type WebSocketLike,
} from '@ogi-sdk/connect';
import { formatError, NetworkError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { randomUUID } from 'crypto';
import { Effect } from 'effect';
import { buildEventMessage } from '../_generated/event-proxy';
import { DeferrableTask } from '../deffered';
import type { AddonServer } from '../server';
import type { AddonConnection } from './addon.connection';
import { bindWebSocketLifecycle } from './websocket-lifecycle';

const logger = createLogger(LOGGER_PREFIXES.addonServer);

type SDKResponseMap = { [Name in SDKRequestName]: SDKResponse<Name> };
type ClientConnectionError = NetworkError | ValidationError;

const readAddonIconPaths = (
  client: AddonConnection | undefined
): Effect.Effect<{ icon?: string; iconPath?: string }> => {
  if (!client?.filePath) return Effect.succeed({});
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(
        readFileSync(join(client.filePath!, 'addon.json'), 'utf-8')
      ) as { icon?: string };
      return typeof parsed.icon === 'string' && parsed.icon
        ? { icon: parsed.icon, iconPath: join(client.filePath!, parsed.icon) }
        : {};
    },
    catch: () => ({}),
  }).pipe(Effect.merge);
};

const ICON_MAX_BYTES: number = 512 * 1024;
const ICON_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

/** An addon's icon as a data url; nothing if it's missing, too big, or outside the addon. */
const readIconDataUrl = (
  addonPath: string,
  iconPath: string
): Effect.Effect<string | undefined> =>
  Effect.tryPromise(async () => {
    const mime: string | undefined =
      ICON_MIME_TYPES[extname(iconPath).toLowerCase()];
    if (!mime) return undefined;
    // real paths, so `"icon": "../../x"` or a symlink can't escape the addon
    const [root, file] = await Promise.all([
      realpath(addonPath),
      realpath(iconPath),
    ]);
    const rel: string = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    if ((await stat(file)).size > ICON_MAX_BYTES) return undefined;
    return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Effect-based SDK websocket connection. */
export class ClientConnection {
  private constructor(
    private readonly socket: WebSocketLike,
    private readonly server: AddonServer,
    private readonly transport: EventResponseSocket<
      AddonClientSDKToServerIncomingMessage,
      AddonServerToClientSDKIncomingMessage
    >
  ) {}

  public static make(
    socket: WebSocketLike,
    server: AddonServer
  ): Effect.Effect<ClientConnection, NetworkError> {
    return Effect.gen(function* () {
      const transport = yield* EventResponseSocket.make<
        AddonClientSDKToServerIncomingMessage,
        AddonServerToClientSDKIncomingMessage
      >(socket, {
        onInvalidMessage: () =>
          Effect.gen(function* () {
            yield* logger.error('Failed to parse websocket message');
            socket.close(1008, 'Invalid JSON message');
          }),
      });
      const connection = new ClientConnection(socket, server, transport);
      yield* connection.setupWebsocket();
      return connection;
    });
  }

  private setupWebsocket(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      yield* this.transport.on('forward', (message) =>
        this.handleForward(message)
      );
      yield* this.transport.on('defer-forward', (message) =>
        this.handleDeferredForward(message)
      );
      yield* this.transport.on('query-connected-addons', (message) =>
        this.handleConnectedAddons(message)
      );
      yield* this.transport.on('get-deferred-tasks', (message) =>
        this.handleDeferredTasks(message)
      );
      yield* this.transport.on('get-deferred-task', (message) =>
        this.handleDeferredTask(message)
      );
      yield* this.transport.on('get-addon-icon', (message) =>
        this.handleGetAddonIcon(message)
      );
      const unbindLifecycle = yield* bindWebSocketLifecycle(
        this.socket,
        (effect) => this.transport.run(effect),
        {
          onClose: () =>
            this.transport.shutdown('Websocket closed').pipe(Effect.ignore),
          onError: () =>
            this.transport.shutdown('Websocket error').pipe(Effect.ignore),
        }
      );
      yield* this.transport.addFinalizer(Effect.sync(unbindLifecycle));
    });
  }

  private handleGetAddonIcon(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!message.id) {
        this.socket.close(1008, 'Query message missing ID');
        return;
      }
      const { addonId } =
        message.args as AddonClientSDKToServerWebsocketMessage<'get-addon-icon'>['args'];

      const client = this.server.getClient(addonId);
      const { iconPath } = yield* readAddonIconPaths(client);
      const iconDataUrl: string | undefined =
        iconPath && client?.filePath
          ? yield* readIconDataUrl(client.filePath, iconPath)
          : undefined;

      yield* this.sendQueryResponse(message.id, { iconDataUrl }).pipe(
        Effect.ignore
      );
    });
  }

  private handleForward(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const { addonId, event, args } =
        message.args as AddonClientSDKToServerWebsocketMessage<'forward'>['args'];
      if (!message.id) {
        this.socket.close(1008, 'Forward message missing ID');
        return;
      }
      const addon = this.server.getClient(addonId);
      if (!addon) {
        yield* this.sendForwardResponse(
          message.id,
          addonId,
          event,
          undefined,
          `Addon not connected: ${addonId}`
        ).pipe(Effect.ignore);
        return;
      }
      const result = yield* addon
        .sendEventMessage(
          buildEventMessage(
            event,
            args as AddonServerToClientEventArgs[AddonServerToClientEventName]
          ),
          event !== 'response'
        )
        .pipe(Effect.either);
      if (result._tag === 'Left') {
        yield* this.sendForwardResponse(
          message.id,
          addonId,
          event,
          undefined,
          formatError(result.left)
        ).pipe(Effect.ignore);
      } else {
        // the addon reports a rejected config as `success: false`, not an error
        const accepted: boolean =
          !result.right.statusError &&
          (result.right.args as { success?: boolean } | undefined)?.success !==
            false;
        if (event === 'config-update' && accepted)
          this.server.rememberConfig(addonId, args[0] as ConfigurationFile);
        yield* this.sendForwardResponse(
          message.id,
          addonId,
          event,
          result.right.args,
          result.right.statusError
        ).pipe(Effect.ignore);
      }
    });
  }

  private handleDeferredForward(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!message.id) {
        this.socket.close(1008, 'Deferred forward message missing ID');
        return;
      }
      const { addonId, event, args } =
        message.args as AddonClientSDKToServerWebsocketMessage<'defer-forward'>['args'];
      const addon = this.server.getClient(addonId);
      if (!addon) {
        yield* this.sendQueryResponse(
          message.id,
          { taskID: '' },
          `Addon not connected: ${addonId}`
        ).pipe(Effect.ignore);
        return;
      }
      const taskID = randomUUID();
      const typedEvent = event as AddonServerToClientEventName;
      const forwardedArgs = [...args];
      if (
        typedEvent === 'task-run' &&
        forwardedArgs[0] &&
        typeof forwardedArgs[0] === 'object' &&
        !Array.isArray(forwardedArgs[0])
      ) {
        forwardedArgs[0] = { ...(forwardedArgs[0] as object), deferID: taskID };
      }
      const eventMessage = buildEventMessage(
        typedEvent,
        forwardedArgs as AddonServerToClientEventArgs[AddonServerToClientEventName]
      );
      eventMessage.id = taskID;
      const task = new DeferrableTask(
        () =>
          addon.sendEventMessage(eventMessage, event !== 'response').pipe(
            Effect.flatMap((response) =>
              response.statusError
                ? Effect.fail(
                    new NetworkError({ message: response.statusError })
                  )
                : Effect.succeed(response.args)
            ),
            // same as a forwarded config-update, so a reconnect replays it
            Effect.tap((result) =>
              Effect.sync(() => {
                if (
                  event === 'config-update' &&
                  (result as { success?: boolean } | undefined)?.success !==
                    false
                )
                  this.server.rememberConfig(
                    addonId,
                    args[0] as ConfigurationFile
                  );
              })
            )
          ),
        addonId
      );
      task.id = taskID;
      yield* this.server.getDeferredTasksManager().startTask(task);
      yield* this.sendQueryResponse(message.id, { taskID }).pipe(Effect.ignore);
    });
  }

  private handleConnectedAddons(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!message.id) {
        this.socket.close(1008, 'Query message missing ID');
        return;
      }
      const addons: ConnectedAddonInfo[] = [];
      for (const addonId of this.addonIdsForQuery()) {
        const client = this.server.getClient(addonId);
        addons.push({
          ...client?.addonInfo,
          id: addonId,
          name: client?.addonInfo?.name ?? '',
          eventsAvailable: client?.eventsAvailable ?? [],
          configTemplate: client?.configTemplate,
          ...(yield* readAddonIconPaths(client)),
        });
      }
      yield* this.sendQueryResponse(message.id, { addons }).pipe(Effect.ignore);
    });
  }

  private handleDeferredTasks(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!message.id) {
        this.socket.close(1008, 'Get deferred tasks message missing ID');
        return;
      }
      const tasks = Object.values(
        this.server.getDeferredTasksManager().getTasks()
      ).map((task) => ({
        id: task.id,
        addonOwner: task.addonOwner,
        finished: task.finished,
        progress: task.progress,
        logs: task.logs,
        failed: task.failed,
      }));
      yield* this.sendQueryResponse(message.id, { tasks }).pipe(Effect.ignore);
    });
  }

  private handleDeferredTask(
    message: AddonClientSDKToServerIncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (!message.id) {
        this.socket.close(1008, 'Get deferred task message missing ID');
        return;
      }
      const taskID = (message.args as { taskID: string }).taskID;
      const manager = this.server.getDeferredTasksManager();
      const task = manager.getTasks()[taskID];
      if (!task) {
        yield* this.sendQueryResponse(
          message.id,
          { task: undefined },
          'Task not found'
        ).pipe(Effect.ignore);
        return;
      }
      if (!this.server.getClient(task.addonOwner) && task.addonOwner !== '*') {
        yield* manager.removeTask(taskID);
        yield* this.sendQueryResponse(
          message.id,
          { task: undefined },
          'Addon is no longer connected'
        ).pipe(Effect.ignore);
        return;
      }
      if (task.failed) {
        yield* manager.removeTask(taskID);
        yield* this.sendQueryResponse(
          message.id,
          { task: undefined },
          task.failed
        ).pipe(Effect.ignore);
        return;
      }
      if (task.finished) {
        yield* manager.removeTask(taskID);
        const data = yield* task
          .getSerializedData()
          .pipe(Effect.catchAll(() => Effect.succeed(task.data)));
        yield* this.sendQueryResponse(message.id, {
          task: {
            id: task.id,
            addonOwner: task.addonOwner,
            finished: true,
            progress: task.progress,
            logs: task.logs,
            failed: task.failed,
            data,
            resolved: true,
          },
        }).pipe(Effect.ignore);
        return;
      }
      yield* this.sendQueryResponse(message.id, {
        task: {
          id: task.id,
          addonOwner: task.addonOwner,
          finished: false,
          progress: task.progress,
          logs: task.logs,
          failed: task.failed,
          resolved: false,
        },
      }).pipe(Effect.ignore);
    });
  }

  private sendForwardResponse(
    id: string,
    addonId: string,
    event: AddonServerToClientEventName,
    args: unknown,
    statusError?: string
  ): Effect.Effect<
    AddonClientSDKToServerWebsocketMessage,
    ClientConnectionError
  > {
    return this.transport.send(
      {
        event: 'forward-response',
        id,
        args: { addonId, event, args },
        statusError,
      } as AddonServerToClientSDKIncomingMessage,
      { expectResponse: false }
    );
  }

  private addonIdsForQuery(): string[] {
    return Array.from(this.server.getConnections())
      .filter((addon) => Boolean(addon.addonInfo?.id))
      .map((addon) => addon.addonInfo!.id);
  }

  private sendQueryResponse<Name extends keyof SDKResponseMap & string>(
    id: string,
    args: SDKResponseMap[Name],
    statusError?: string
  ): Effect.Effect<
    AddonClientSDKToServerWebsocketMessage,
    ClientConnectionError
  > {
    return this.transport.send(
      {
        event: 'response',
        id,
        args,
        statusError,
      } as AddonServerToClientSDKWebsocketMessage<'response'>,
      { expectResponse: false }
    );
  }

  public sendNotification(
    notification: AddonNotificationMessage
  ): Effect.Effect<void, ClientConnectionError> {
    return this.transport
      .send(
        {
          event: 'notification',
          args: notification,
        } as AddonServerToClientSDKWebsocketMessage<'notification'>,
        { expectResponse: false }
      )
      .pipe(Effect.asVoid);
  }

  public askInput(
    name: string,
    description: string,
    config: ConfigurationFile
  ): Effect.Effect<
    Record<string, string | number | boolean>,
    ClientConnectionError
  > {
    return this.transport
      .send(
        {
          event: 'input-asked',
          args: { name, description, config },
        } as AddonServerToClientSDKWebsocketMessage<'input-asked'>,
        { expectResponse: true, responseEvent: 'input-response' }
      )
      .pipe(
        Effect.map(
          (response) =>
            response.args as Record<string, string | number | boolean>
        )
      );
  }

  public close(): Effect.Effect<void, NetworkError> {
    return this.transport.shutdown('SDK connection closed');
  }
}
