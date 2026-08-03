import { AddonError } from '@ogi/errors';
import { Effect } from 'effect';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';

type InputValues = Record<string, string | number | boolean>;
type InputCallback = <U extends InputValues>(
  screen: ConfigurationBuilder<U>,
  name: string,
  description: string
) => Effect.Effect<U, AddonError> | Promise<U>;

export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  progress: number = 0;
  logs: string[] = [];
  failed: string | undefined = undefined;
  onInputAsked?: InputCallback;
  private readonly deferredEffects: Effect.Effect<void, unknown>[] = [];
  private readonly deferredWaiters = new Set<
    (effect: Effect.Effect<void, unknown> | undefined) => void
  >();

  constructor(onInputAsked?: InputCallback) {
    this.onInputAsked = onInputAsked;
  }

  public defer(
    effect?: () => Effect.Effect<void, unknown> | Promise<void>
  ): void {
    this.deffered = true;
    if (!effect) return;

    const deferredEffect = Effect.try({
      try: effect,
      catch: (cause) =>
        new AddonError({
          message: `Deferred event failed: ${String(cause)}`,
        }),
    }).pipe(
      Effect.flatMap((result) =>
        Effect.isEffect(result)
          ? result
          : Effect.tryPromise({
              try: () => result,
              catch: (cause) =>
                new AddonError({
                  message: `Deferred event failed: ${String(cause)}`,
                }),
            })
      )
    );
    const waiter = this.deferredWaiters.values().next().value;
    if (waiter) {
      this.deferredWaiters.delete(waiter);
      waiter(deferredEffect);
    } else {
      this.deferredEffects.push(deferredEffect);
    }
  }

  /** Returns queued deferred work without waiting for later registrations. */
  public takeDeferredEffect(): Effect.Effect<void, unknown> | undefined {
    return this.deferredEffects.shift();
  }

  /** Waits for deferred work registered before or after event emission. */
  public awaitDeferredEffect(): Effect.Effect<
    Effect.Effect<void, unknown> | undefined
  > {
    return Effect.async((resume) => {
      const deferredEffect = this.takeDeferredEffect();
      if (deferredEffect || this.resolved) {
        resume(Effect.succeed(deferredEffect));
        return Effect.void;
      }

      const waiter = (effect: Effect.Effect<void, unknown> | undefined): void =>
        resume(Effect.succeed(effect));
      this.deferredWaiters.add(waiter);
      return Effect.sync(() => this.deferredWaiters.delete(waiter));
    });
  }

  private finish(): void {
    this.resolved = true;
    for (const waiter of this.deferredWaiters) waiter(undefined);
    this.deferredWaiters.clear();
  }

  /**
   * Resolve the event with data. This acts like a promise resolve, and will stop the event from being processed further. **You must always call this method when you are done with the event.**
   * @param data {T}
   */
  public resolve(data: T): void {
    this.data = data;
    this.finish();
  }

  /**
   * Completes the event and resolves it, but does not return any data. **You must always call this method when you are done with the event.**
   */
  public complete(): void {
    this.finish();
  }

  public fail(message: string): void {
    this.failed = message;
    this.finish();
  }

  /**
   * Logs a message to the event. This is useful for debugging and logging information to the user.
   * @param message {string}
   */
  public log(message: string): void {
    this.logs.push(message);
  }

  /** Effect-native input request API. */
  public askForInputEffect<U extends InputValues>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Effect.Effect<U, AddonError> {
    if (!this.onInputAsked) {
      return Effect.fail(
        new AddonError({ message: 'No input callback is registered' })
      );
    }
    return Effect.suspend(() => {
      const result = this.onInputAsked!(screen, name, description);
      return Effect.isEffect(result)
        ? result
        : Effect.tryPromise({
            try: () => result,
            catch: (cause) =>
              new AddonError({
                message: `Input request failed: ${String(cause)}`,
              }),
          });
    });
  }

  /** Promise compatibility adapter for existing addon implementations. */
  public askForInput<U extends InputValues>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Promise<U> {
    return Effect.runPromise(this.askForInputEffect(name, description, screen));
  }
}
