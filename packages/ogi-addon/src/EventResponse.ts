import { AddonError } from '@ogi-sdk/errors';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';

type InputValues = Record<string, string | number | boolean>;
type InputCallback = <U extends InputValues>(
  screen: ConfigurationBuilder<U>,
  name: string,
  description: string
) => Promise<U>;

/** Work registered by addon code to run while the event is deferred. */
export type DeferredWork = () => void | Promise<void>;

export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  progress: number = 0;
  logs: string[] = [];
  failed: string | undefined = undefined;
  private onInputAsked?: InputCallback;
  private readonly deferredQueue: DeferredWork[] = [];
  private readonly deferredWaiters = new Set<
    (work: DeferredWork | undefined) => void
  >();

  constructor(onInputAsked?: InputCallback) {
    this.onInputAsked = onInputAsked;
  }

  public defer(work?: DeferredWork): void {
    this.deffered = true;
    if (!work) return;

    const waiter = this.deferredWaiters.values().next().value;
    if (waiter) {
      this.deferredWaiters.delete(waiter);
      waiter(work);
    } else {
      this.deferredQueue.push(work);
    }
  }

  /** Resolves with queued work immediately, waits for later registrations, and resolves `undefined` once the event settles. */
  public nextDeferred(): Promise<DeferredWork | undefined> {
    const queued = this.deferredQueue.shift();
    if (queued || this.resolved) return Promise.resolve(queued);

    return new Promise((resolve) => {
      const waiter = (work: DeferredWork | undefined): void => resolve(work);
      this.deferredWaiters.add(waiter);
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

  /** Ask the user for input; rejects with an {@link AddonError} when no callback is registered. */
  public askForInput<U extends InputValues>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Promise<U> {
    if (!this.onInputAsked) {
      return Promise.reject(
        new AddonError({ message: 'No input callback is registered' })
      );
    }
    return Promise.resolve(this.onInputAsked(screen, name, description));
  }
}
