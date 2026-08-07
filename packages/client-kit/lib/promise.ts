import type {
  AddonForwardResponse,
  AddonServerToClientEventArgs,
  AddonServerToClientEventName,
  AddonServerToClientSDKEvent,
  AddonServerToClientSDKEventArgs,
  SDKRequest,
  SDKRequestName,
  SDKResponseMessage,
} from '@ogi-sdk/connect';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Fiber, Stream } from 'effect';
import type {
  AddonProxyMetadata,
  EffectAddonProxy,
} from './_generated/addon-proxy';
import { addonEventAliases } from './_generated/addon-proxy';
import type {
  ConnectionOptions,
  DeferredTaskSnapshot,
  EffectDeferredTaskOptions,
  SDKEventArgs,
} from './connection';
import { EffectConnection } from './connection';

const logger = createLogger(LOGGER_PREFIXES.clientKit);
const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(logger.observe(effect));

type MaybePromise = void | Promise<void>;

export type DeferredTaskOptions<T = unknown> = {
  readonly interval?: number;
  readonly onTaskStarted?: (taskID: string) => MaybePromise;
  readonly onProgress?: (
    progress: number,
    task: DeferredTaskSnapshot<T>
  ) => MaybePromise;
  readonly onLogs?: (
    logs: string[],
    task: DeferredTaskSnapshot<T>
  ) => MaybePromise;
  readonly onFailed?: (error: string) => MaybePromise;
};

type InputAskedArgs = AddonServerToClientSDKEventArgs['input-asked'] & {
  readonly reply: (
    result: Record<string, string | number | boolean>
  ) => Promise<void>;
};

type PromiseSDKEventArgs<Event extends AddonServerToClientSDKEvent> =
  Event extends 'input-asked'
    ? InputAskedArgs
    : AddonServerToClientSDKEventArgs[Event];

type AddonProxyMethod<Event extends AddonServerToClientEventName> = (
  ...args: AddonServerToClientEventArgs[Event]
) => Promise<AddonForwardResponse<Event>['args']>;

type CamelCaseEvent<Event extends string> =
  Event extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<CamelCaseEvent<Tail>>}`
    : Event;

/** Promise compatibility view of the generated Effect addon proxy. */
export type AddonProxy = AddonProxyMetadata & {
  [Event in AddonServerToClientEventName as CamelCaseEvent<Event>]: AddonProxyMethod<Event>;
};

const callbackEffect = (callback: () => MaybePromise): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => callback(),
    catch: (cause) => cause,
  }).pipe(
    Effect.tapError((error) =>
      logger.error('Deferred task callback failed:', error)
    ),
    Effect.ignore
  );

const toEffectOptions = <T>(
  options: DeferredTaskOptions<T>
): EffectDeferredTaskOptions<T> => ({
  interval: options.interval,
  onTaskStarted: options.onTaskStarted
    ? (taskID) => callbackEffect(() => options.onTaskStarted!(taskID))
    : undefined,
  onProgress: options.onProgress
    ? (progress, task) =>
        callbackEffect(() => options.onProgress!(progress, task))
    : undefined,
  onLogs: options.onLogs
    ? (logs, task) => callbackEffect(() => options.onLogs!(logs, task))
    : undefined,
  onFailed: options.onFailed
    ? (error) => callbackEffect(() => options.onFailed!(error))
    : undefined,
});

const toPromiseAddonProxy = (proxy: EffectAddonProxy): AddonProxy =>
  new Proxy({} as AddonProxy, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (Object.hasOwn(addonEventAliases, property)) {
        const method = (
          proxy as unknown as Record<
            string,
            (...values: unknown[]) => Effect.Effect<unknown>
          >
        )[property];
        if (!method) return undefined;
        return (...args: unknown[]) => runPromise(method(...args));
      }
      return (proxy as unknown as Record<string, unknown>)[property];
    },
  });

/**
 * Promise compatibility adapter. New Effect-native integrations should use
 * {@link EffectConnection} directly.
 */
export class Connection {
  private constructor(private readonly effect: EffectConnection) {}

  public static make(options: ConnectionOptions): Promise<Connection> {
    return runPromise(
      EffectConnection.make(options).pipe(
        Effect.map((effect) => new Connection(effect))
      )
    );
  }

  public addon(
    addonId: string,
    deferredOptions: DeferredTaskOptions = {}
  ): AddonProxy {
    return toPromiseAddonProxy(
      this.effect.addon(addonId, toEffectOptions(deferredOptions))
    );
  }

  public sendToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ) {
    return runPromise(this.effect.sendToAddon(addonId, event, ...args));
  }

  public request<Name extends Exclude<SDKRequestName, 'forward'>>(
    name: Name,
    args: SDKRequest<Name>
  ): Promise<SDKResponseMessage<Name>> {
    return runPromise(this.effect.request(name, args));
  }

  public deferToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Promise<string> {
    return runPromise(this.effect.deferToAddon(addonId, event, ...args));
  }

  public getDeferredTask<T = unknown>(
    taskID: string
  ): Promise<DeferredTaskSnapshot<T> | undefined> {
    return runPromise(this.effect.getDeferredTask<T>(taskID));
  }

  public getDeferredTasks(): Promise<DeferredTaskSnapshot[]> {
    return runPromise(this.effect.getDeferredTasks());
  }

  public waitForDeferredTask<T = unknown>(
    taskID: string,
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    return runPromise(
      this.effect.waitForDeferredTask(taskID, toEffectOptions(options))
    );
  }

  public deferToAddonAndWait<
    T = unknown,
    Event extends AddonServerToClientEventName = AddonServerToClientEventName,
  >(
    addonId: string,
    event: Event,
    args: AddonServerToClientEventArgs[Event],
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    return runPromise(
      this.effect.deferToAddonAndWait(
        addonId,
        event,
        args,
        toEffectOptions(options)
      )
    );
  }

  public events<Event extends AddonServerToClientSDKEvent>(
    event: Event
  ): Stream.Stream<PromiseSDKEventArgs<Event>> {
    return this.effect
      .events(event)
      .pipe(Stream.map((args) => this.toPromiseEventArgs(event, args)));
  }

  public on<Event extends AddonServerToClientSDKEvent, E>(
    event: Event,
    callback: (
      args: PromiseSDKEventArgs<Event>
    ) => Effect.Effect<void, E> | void
  ): Promise<Fiber.RuntimeFiber<void, E>> {
    return runPromise(
      this.effect.on(event, (args) => {
        const result = callback(this.toPromiseEventArgs(event, args));
        return Effect.isEffect(result) ? result : Effect.void;
      })
    );
  }

  public close(): Promise<void> {
    return runPromise(this.effect.close());
  }

  public dispose(): Promise<void> {
    return this.close();
  }

  private toPromiseEventArgs<Event extends AddonServerToClientSDKEvent>(
    event: Event,
    args: SDKEventArgs<Event>
  ): PromiseSDKEventArgs<Event> {
    if (event !== 'input-asked') return args as PromiseSDKEventArgs<Event>;
    const input = args as SDKEventArgs<'input-asked'>;
    return {
      ...input,
      reply: (result: Record<string, string | number | boolean>) =>
        runPromise(input.reply(result)),
    } as PromiseSDKEventArgs<Event>;
  }
}
