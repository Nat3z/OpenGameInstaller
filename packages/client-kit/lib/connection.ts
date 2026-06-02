import { EventResponseSocket } from '@ogi-sdk/connect';
import { createAddonProxy } from './_generated/addon-proxy';
import type {
  AddonClientSDKToServerIncomingMessage,
  AddonClientSDKToServerWebsocketMessage,
  AddonForwardResponse,
  AddonServerToClientEventArgs,
  AddonServerToClientEventName,
  AddonServerToClientSDKEvent,
  AddonServerToClientSDKEventArgs,
  AddonServerToClientSDKIncomingMessage,
  ConnectedAddonInfo,
  SDKRequest,
  SDKRequestName,
  SDKResponseMessage,
  WebSocketLike,
} from '@ogi-sdk/connect';
import type {
  AddonForwardResponseMessage,
  AddonProxy,
} from './_generated/addon-proxy';

type WebSocketConstructor = new (url: string) => WebSocketLike;

export type ConnectionOptions = {
  url: string;
  secret?: string;
  webSocket?: WebSocketConstructor;
};

export type DeferredTaskSnapshot<T = unknown> = {
  id: string;
  addonOwner: string;
  finished: boolean;
  progress: number;
  logs: string[];
  failed?: string;
  data?: T;
  resolved: boolean;
};

export type DeferredTaskOptions<T = unknown> = {
  interval?: number;
  onTaskStarted?: (taskID: string) => void;
  onProgress?: (progress: number, task: DeferredTaskSnapshot<T>) => void;
  onLogs?: (logs: string[], task: DeferredTaskSnapshot<T>) => void;
  onFailed?: (error: string) => void;
};

type Listener = (args: unknown) => void;

type InputAskedArgs = AddonServerToClientSDKEventArgs['input-asked'] & {
  reply: (result: Record<string, string | number | boolean>) => Promise<void>;
};

type SDKEventCallback<Event extends AddonServerToClientSDKEvent> = Event extends 'input-asked'
  ? (args: InputAskedArgs) => void
  : (args: AddonServerToClientSDKEventArgs[Event]) => void;

class TinyEventEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, callback: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(event, listeners);
  }

  clear(): void {
    this.listeners.clear();
  }

  emit(event: string, args: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(args));
  }
}

/** Anything in `addonProtocol.sdkToServer` that uses the generic `'response'` reply (i.e. not `forward`). */
type GenericRequestName = Exclude<SDKRequestName, 'forward'>;

export class Connection {
  private socket: WebSocketLike;
  private transport: EventResponseSocket<
    AddonServerToClientSDKIncomingMessage,
    AddonClientSDKToServerIncomingMessage
  >;
  private readonly eventEmitter = new TinyEventEmitter();
  private readonly ready: Promise<void>;
  private readonly connectedAddonInfo = new Map<string, ConnectedAddonInfo>();

  constructor(options: ConnectionOptions) {
    const WebSocketConstructor =
      options.webSocket ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WebSocketConstructor) {
      throw new Error('No WebSocket implementation available');
    }

    this.socket = new WebSocketConstructor(this.getSDKUrl(options.url));
    this.transport = new EventResponseSocket(this.socket, {
      onInvalidMessage: () => {
        console.error('Failed to parse websocket message');
        this.socket.close(1008, 'Invalid JSON message');
      },
    });
    this.ready = this.connect();
  }

  public addon(addonId: string, deferredOptions: DeferredTaskOptions = {}): AddonProxy {
    return createAddonProxy(
      addonId,
      this.sendToAddon.bind(this),
      this.createDeferToAddon(deferredOptions),
      (id) => this.connectedAddonInfo.get(id)
    );
  }

  public async sendToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Promise<AddonForwardResponseMessage<Event>> {
    await this.ready;
    return (await this.transport.send(
      {
        event: 'forward',
        args: {
          addonId,
          event,
          args,
        },
      } as AddonClientSDKToServerWebsocketMessage<'forward', Event>,
      { expectResponse: true, responseEvent: 'forward-response' }
    )) as AddonForwardResponseMessage<Event>;
  }

  public async request<Name extends GenericRequestName>(
    name: Name,
    args: SDKRequest<Name>
  ): Promise<SDKResponseMessage<Name>> {
    await this.ready;
    const response = (await this.transport.send(
      {
        event: name,
        args,
      } as AddonClientSDKToServerIncomingMessage,
      { expectResponse: true, responseEvent: 'response' }
    )) as SDKResponseMessage<Name>;

    if (name === 'query-connected-addons' && !response.statusError) {
      const addons = (
        response as SDKResponseMessage<'query-connected-addons'>
      ).args.addons;
      for (const addon of addons) {
        this.connectedAddonInfo.set(addon.id, addon);
      }
    }

    return response;
  }

  public async deferToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Promise<string> {
    const response = await this.request('defer-forward', {
      addonId,
      event,
      args,
    });
    if (response.statusError) {
      throw new Error(response.statusError);
    }
    return response.args.taskID;
  }

  public async getDeferredTask<T = unknown>(
    taskID: string
  ): Promise<DeferredTaskSnapshot<T> | undefined> {
    const response = await this.request('get-deferred-task', { taskID });
    if (response.statusError) {
      throw new Error(response.statusError);
    }
    return response.args.task as DeferredTaskSnapshot<T> | undefined;
  }

  public async getDeferredTasks(): Promise<DeferredTaskSnapshot[]> {
    const response = await this.request('get-deferred-tasks', {});
    if (response.statusError) {
      throw new Error(response.statusError);
    }
    return response.args.tasks as DeferredTaskSnapshot[];
  }

  public async waitForDeferredTask<T = unknown>(
    taskID: string,
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    const interval = options.interval ?? 50;

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      let inFlight = false;
      const timer = setInterval(async () => {
        if (settled || inFlight) return;
        inFlight = true;

        try {
          const task = await this.getDeferredTask<T>(taskID);
          if (!task) {
            settled = true;
            clearInterval(timer);
            reject(new Error('Task not found'));
            return;
          }

          options.onProgress?.(task.progress, task);
          options.onLogs?.(task.logs, task);

          if (task.failed) {
            settled = true;
            clearInterval(timer);
            options.onFailed?.(task.failed);
            reject(new Error(task.failed));
            return;
          }

          if (task.resolved) {
            settled = true;
            clearInterval(timer);
            resolve(task.data);
          }
        } catch (error) {
          settled = true;
          clearInterval(timer);
          const message = error instanceof Error ? error.message : String(error);
          options.onFailed?.(message);
          reject(error);
        } finally {
          inFlight = false;
        }
      }, interval);
    });
  }

  public async deferToAddonAndWait<T = unknown, Event extends AddonServerToClientEventName = AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    args: AddonServerToClientEventArgs[Event],
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    const taskID = await this.deferToAddon(addonId, event, ...args);
    return this.waitForDeferredTask<T>(taskID, options);
  }

  public on<Event extends AddonServerToClientSDKEvent>(
    event: Event,
    callback: SDKEventCallback<Event>
  ): void {
    this.eventEmitter.on(event, callback as Listener);
  }

  public close(): void {
    this.eventEmitter.clear();
    this.transport.rejectPendingResponses('Connection closed');
    this.socket.close();
  }

  public dispose(): void {
    this.close();
  }

  private async connect(): Promise<void> {
    this.transport.on(
      'notification',
      (message) => void this.eventEmitter.emit('notification', message.args)
    );

    this.transport.on('input-asked', async (message) => {
      if (!message.id) return;
      this.eventEmitter.emit('input-asked', {
        ...message.args,
        reply: async (result: Record<string, string | number | boolean>) => {
          await this.transport.send(
            {
              event: 'input-response',
              id: message.id,
              args: result,
            } as AddonClientSDKToServerIncomingMessage,
            { expectResponse: false }
          );
        },
      });
    });

    if (this.socket.readyState === 1) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        const socketWithOff = this.socket as WebSocketLike & {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        socketWithOff.off?.('open', onOpen);
        socketWithOff.off?.('error', onError);
        socketWithOff.off?.('close', onClose);
        socketWithOff.removeEventListener?.('open', onOpen);
        socketWithOff.removeEventListener?.('error', onError);
        socketWithOff.removeEventListener?.('close', onClose);
        clearTimeout(timeout);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error?: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error('WebSocket connection error'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('WebSocket closed before opening'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('WebSocket connection timed out'));
      }, 10000);

      if (this.socket.on) {
        this.socket.on('open', onOpen);
        this.socket.on('error', onError);
        this.socket.on('close', onClose);
        return;
      }

      this.socket.addEventListener?.('open', onOpen);
      this.socket.addEventListener?.('error', onError);
      this.socket.addEventListener?.('close', onClose);
    });
  }

  private createDeferToAddon(deferredOptions: DeferredTaskOptions = {}) {
    return async <Event extends AddonServerToClientEventName>(
      targetAddonId: string,
      event: Event,
      args: AddonServerToClientEventArgs[Event]
    ): Promise<AddonForwardResponse<Event>['args']> => {
      const taskID = await this.deferToAddon(targetAddonId, event, ...args);
      deferredOptions.onTaskStarted?.(taskID);
      const result = await this.waitForDeferredTask<AddonForwardResponse<Event>['args']>(
        taskID,
        deferredOptions as DeferredTaskOptions<AddonForwardResponse<Event>['args']>
      );
      return result as AddonForwardResponse<Event>['args'];
    };
  }

  private getSDKUrl(url: string): string {
    const parsed = new URL(url);
    if (parsed.pathname === '/') {
      parsed.pathname = '/sdk';
    }
    return parsed.toString();
  }
}
