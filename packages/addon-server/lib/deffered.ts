import { formatError, ValidationError } from '@ogi/errors';
import { Effect, Fiber } from 'effect';

/** Safely serializes task data and removes Proxy wrappers. */
const safeSerialize = <T>(data: T): Effect.Effect<T, ValidationError> =>
  Effect.try({
    try: () =>
      data === null || data === undefined
        ? data
        : (JSON.parse(JSON.stringify(data)) as T),
    catch: (cause) =>
      new ValidationError({
        message: `Failed to serialize deferred task data: ${String(cause)}`,
      }),
  });

export class DeferrableTask<T> {
  public finished = false;
  public data: T | null = null;
  public id = Math.random().toString(36).substring(7);
  public readonly addonOwner: string;
  public logs: string[] = [];
  public progress = 0;
  public failed: string | undefined;

  public constructor(
    private readonly task: () => Effect.Effect<T, unknown>,
    addonOwner: string
  ) {
    this.addonOwner = addonOwner;
  }

  public run(): Effect.Effect<void> {
    return this.task().pipe(
      Effect.flatMap((result) =>
        safeSerialize(result).pipe(
          Effect.catchAll((error) => {
            console.warn(error.message);
            return Effect.succeed(result);
          })
        )
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          this.data = result;
          this.finished = true;
          console.log('task finished', this.id);
        })
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.failed = formatError(error);
          this.data = null;
          this.finished = true;
        })
      ),
      Effect.asVoid
    );
  }

  public getSerializedData(): Effect.Effect<T | null, ValidationError> {
    return safeSerialize(this.data);
  }
}

export class DeferredTasksManager {
  private readonly tasks: Record<string, DeferrableTask<unknown>> = {};
  private readonly fibers = new Map<string, Fiber.RuntimeFiber<void, never>>();

  public getTasks(): Record<string, DeferrableTask<unknown>> {
    return this.tasks;
  }

  public addTask(task: DeferrableTask<unknown>): Effect.Effect<void> {
    return Effect.sync(() => {
      this.tasks[task.id] = task;
    });
  }

  /** Starts a task and retains its fiber until removal or server shutdown. */
  public startTask(task: DeferrableTask<unknown>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* this.addTask(task);
      const fiber = yield* Effect.forkDaemon(task.run());
      this.fibers.set(task.id, fiber);
    });
  }

  public removeTask(id: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const fiber = this.fibers.get(id);
      if (fiber) yield* Fiber.interrupt(fiber);
      this.fibers.delete(id);
      delete this.tasks[id];
    });
  }

  public shutdown(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.forEach(this.fibers.values(), Fiber.interrupt, {
        discard: true,
      });
      this.fibers.clear();
      for (const id of Object.keys(this.tasks)) delete this.tasks[id];
    });
  }
}
