import { formatError, ValidationError } from '@ogi/errors';
import { Effect } from 'effect';

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

  public getTasks(): Record<string, DeferrableTask<unknown>> {
    return this.tasks;
  }

  public addTask(task: DeferrableTask<unknown>): Effect.Effect<void> {
    return Effect.sync(() => {
      this.tasks[task.id] = task;
    });
  }

  public removeTask(id: string): Effect.Effect<void> {
    return Effect.sync(() => {
      delete this.tasks[id];
    });
  }
}
