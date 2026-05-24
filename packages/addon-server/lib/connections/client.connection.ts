import { randomUUID } from 'crypto';
import {
  EventResponseSocket,
  type AddonClientSDKToServerIncomingMessage,
  type AddonClientSDKToServerWebsocketMessage,
  type AddonServerToClientEventArgs,
  type AddonServerToClientEventName,
  type AddonServerToClientSDKIncomingMessage,
  type AddonServerToClientSDKWebsocketMessage,
  type SDKRequestName,
  type SDKResponse,
  type AddonNotificationMessage,
  type ConfigurationFile,
} from '@ogi-sdk/connect';
import { buildEventMessage } from '../_generated/event-proxy';
import { DeferrableTask } from '../deffered';
import type { AddonServer } from '../server';
import type { AddonConnection } from './addon.connection';

interface ClientWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (rawMessage: unknown) => void): unknown;
  on(event: 'close' | 'error' | 'open', listener: (...args: unknown[]) => void): unknown;
  readyState: number;
}

type SDKResponseMap = {
  [Name in SDKRequestName]: SDKResponse<Name>;
};

export class ClientConnection {
  private socket: ClientWebSocket;
  private transport: EventResponseSocket<
    AddonClientSDKToServerIncomingMessage,
    AddonServerToClientSDKIncomingMessage
  >;
  private server: AddonServer;

  constructor(socket: ClientWebSocket, server: AddonServer) {
    this.socket = socket;
    this.server = server;
    this.transport = new EventResponseSocket(this.socket, {
      onInvalidMessage: () => {
        console.error('Failed to parse websocket message');
        this.socket.close(1008, 'Invalid JSON message');
      },
    });

    this.setupWebsocket();
  }

  private setupWebsocket(): void {
    this.transport.on('forward', async (message) => {
      const { addonId, event, args } = message.args;
      const addon = this.server.getClient(addonId);

      if (!message.id) {
        this.socket.close(1008, 'Forward message missing ID');
        return;
      }

      if (!addon) {
        await this.sendForwardResponse(
          message.id,
          addonId,
          event,
          undefined,
          `Addon not connected: ${addonId}`
        );
        return;
      }

      try {
        const response = await addon.sendEventMessage(
          buildEventMessage(
            event,
            args as AddonServerToClientEventArgs[AddonServerToClientEventName]
          ),
          event !== 'response'
        );

        await this.sendForwardResponse(
          message.id,
          addonId,
          event,
          response.args,
          response.statusError
        );
      } catch (error) {
        await this.sendForwardResponse(
          message.id,
          addonId,
          event,
          undefined,
          error instanceof Error ? error.message : String(error)
        );
      }
    });

    this.transport.on('defer-forward', async (message) => {
      if (!message.id) {
        this.socket.close(1008, 'Deferred forward message missing ID');
        return;
      }

      const { addonId, event, args } = message.args;
      const addon = this.server.getClient(addonId);
      if (!addon) {
        await this.sendQueryResponse(
          message.id,
          { taskID: '' },
          `Addon not connected: ${addonId}`
        );
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

      const task = new DeferrableTask(async () => {
        const response = await addon.sendEventMessage(
          eventMessage,
          event !== 'response'
        );
        if (response.statusError) {
          throw new Error(response.statusError);
        }
        return response.args;
      }, addonId);
      task.id = taskID;
      this.server.getDeferredTasksManager().addTask(task);
      void task.run().catch((error) => {
        console.error('Deferred task failed:', error);
      });

      await this.sendQueryResponse(message.id, { taskID });
    });

    this.transport.on('query-connected-addons', async (message) => {
      if (!message.id) {
        this.socket.close(1008, 'Query message missing ID');
        return;
      }

      try {
        const addonIds = this.addonIdsForQuery();
        await this.sendQueryResponse(message.id, {
          addons: addonIds.map((addonId) => {
            const client = this.server.getClient(addonId);
            return {
              ...client?.addonInfo,
              id: addonId,
              name: client?.addonInfo?.name ?? '',
              eventsAvailable: client?.eventsAvailable ?? [],
              configTemplate: client?.configTemplate,
            };
          }),
        });
      } catch (error) {
        await this.sendQueryResponse(
          message.id,
          { addons: [] },
          error instanceof Error ? error.message : String(error)
        );
      }
    });

    this.transport.on('get-deferred-tasks', async (message) => {
      if (!message.id) {
        this.socket.close(1008, 'Get deferred tasks message missing ID');
        return;
      }

      try {
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
        await this.sendQueryResponse(message.id, { tasks });
      } catch (error) {
        await this.sendQueryResponse(
          message.id,
          { tasks: [] },
          error instanceof Error ? error.message : String(error)
        );
      }
    });

    this.transport.on('get-deferred-task', async (message) => {
      if (!message.id) {
        this.socket.close(1008, 'Get deferred task message missing ID');
        return;
      }

      const taskID = message.args.taskID;
      const deferredTasksManager = this.server.getDeferredTasksManager();
      const task = deferredTasksManager.getTasks()[taskID];

      if (!task) {
        await this.sendQueryResponse(
          message.id,
          { task: undefined },
          'Task not found'
        );
        return;
      }

      const stillExists = this.server.getClient(task.addonOwner) !== undefined;
      if (!stillExists && task.addonOwner !== '*') {
        deferredTasksManager.removeTask(taskID);
        await this.sendQueryResponse(
          message.id,
          { task: undefined },
          'Addon is no longer connected'
        );
        return;
      }

      if (task.failed) {
        deferredTasksManager.removeTask(taskID);
        await this.sendQueryResponse(
          message.id,
          { task: undefined },
          task.failed
        );
        return;
      }

      if (task.finished) {
        deferredTasksManager.removeTask(taskID);
        await this.sendQueryResponse(message.id, {
          task: {
            id: task.id,
            addonOwner: task.addonOwner,
            finished: task.finished,
            progress: task.progress,
            logs: task.logs,
            failed: task.failed,
            data: task.getSerializedData(),
            resolved: true,
          },
        });
        return;
      }

      await this.sendQueryResponse(message.id, {
        task: {
          id: task.id,
          addonOwner: task.addonOwner,
          finished: task.finished,
          progress: task.progress,
          logs: task.logs,
          failed: task.failed,
          resolved: false,
        },
      });
    });

    this.socket.on('close', () =>
      this.transport.rejectPendingResponses('Websocket closed')
    );
    this.socket.on('error', () =>
      this.transport.rejectPendingResponses('Websocket error')
    );
  }

  private sendForwardResponse(
    id: string,
    addonId: string,
    event: AddonServerToClientEventName,
    args: unknown,
    statusError?: string
  ): Promise<AddonClientSDKToServerWebsocketMessage> {
    return this.transport.send(
      {
        event: 'forward-response',
        id,
        args: {
          addonId,
          event,
          args,
        },
        statusError,
      } as AddonServerToClientSDKIncomingMessage,
      { expectResponse: false }
    );
  }

  private addonIdsForQuery(): string[] {
    return Array.from(this.server.getConnections())
      .filter((addon: AddonConnection) => Boolean(addon.addonInfo?.id))
      .map((addon) => addon.addonInfo!.id);
  }

  private sendQueryResponse<Name extends keyof SDKResponseMap & string>(
    id: string,
    args: SDKResponseMap[Name],
    statusError?: string
  ): Promise<AddonClientSDKToServerWebsocketMessage> {
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

  public sendNotification(notification: AddonNotificationMessage): Promise<AddonClientSDKToServerWebsocketMessage> {
    return this.transport.send(
      {
        event: 'notification',
        args: notification,
      } as AddonServerToClientSDKWebsocketMessage<'notification'>,
      { expectResponse: false }
    );
  }

  public async askInput(
    name: string,
    description: string,
    config: ConfigurationFile
  ): Promise<Record<string, string | number | boolean>> {
    const response = await this.transport.send(
      {
        event: 'input-asked',
        args: { name, description, config },
      } as AddonServerToClientSDKWebsocketMessage<'input-asked'>,
      { expectResponse: true, responseEvent: 'input-response' }
    );

    return response.args as Record<string, string | number | boolean>;
  }

  public close(): void {
    this.socket.close();
  }
}
