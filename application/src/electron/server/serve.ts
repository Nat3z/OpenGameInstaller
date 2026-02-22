import { z } from 'zod';
import { DeferrableTask, DeferredTasks } from './DeferrableTask.js';

export class ProcedureReturnType<tag = string> {
  public tag: tag;
  public status: number;
  constructor(tag: tag, status: number) {
    this.tag = tag;
    this.status = status;
  }
}

export class ProcedureDeferTask extends ProcedureReturnType<'defer'> {
  public deferrableTask: DeferrableTask<any>;
  constructor(status: number, deferrableTask: DeferrableTask<any>) {
    super('defer', status);
    this.deferrableTask = deferrableTask;
  }
}

export class ProcedureJSON<T> extends ProcedureReturnType<'json'> {
  public data: T;
  constructor(status: number, data: T) {
    super('json', status);
    this.data = data;
  }
}

export class ProcedureError extends ProcedureReturnType<'error'> {
  public error: string;
  constructor(status: number, error: string) {
    super('error', status);
    this.error = error;
  }
}

export const requestSchema = z.object({
  method: z.string(),
  params: z.unknown(),
});

export type ProcedureRequest = z.infer<typeof requestSchema>;
type ValidProcedureReturnType =
  | ProcedureDeferTask
  | ProcedureJSON<any>
  | ProcedureError;

export class Procedure<TInput = unknown> {
  private inputSchema?: z.ZodType<TInput>;
  private handlerFn?: (input: TInput) => Promise<ValidProcedureReturnType>;

  public input<T>(schema: z.ZodType<T>): Procedure<T> {
    const newProcedure = new Procedure<T>();
    newProcedure.inputSchema = schema;
    return newProcedure;
  }

  public handler(
    handler: (input: TInput) => Promise<ValidProcedureReturnType>
  ): Procedure<TInput> {
    this.handlerFn = handler;
    return this;
  }

  public getInputSchema(): z.ZodType<TInput> | undefined {
    return this.inputSchema;
  }

  public getHandler():
    | ((input: TInput) => Promise<ValidProcedureReturnType>)
    | undefined {
    return this.handlerFn;
  }
}

export const procedure = <TInput = unknown>() => {
  return new Procedure<TInput>();
};

export class AddonServer {
  private procedures: Record<string, Procedure> = {};

  public registerProcedure(name: string, proc: Procedure) {
    this.procedures[name] = proc;
  }

  constructor(procedures: Record<string, Procedure>) {
    this.procedures = procedures;
  }

  public async handleRequest(request: ProcedureRequest) {
    const proc = this.procedures[request.method];
    if (!proc) {
      return new ProcedureError(404, 'Procedure not found');
    }
    const inputSchema = proc.getInputSchema();
    if (!inputSchema) {
      return new ProcedureError(400, 'Procedure has no input schema');
    }

    const inputSafe = inputSchema.safeParse(request.params);
    if (!inputSafe.success) {
      const message =
        inputSafe.error.message ||
        'Invalid input: ' + JSON.stringify(inputSafe.error.issues);
      return new ProcedureError(400, message);
    }

    const handler = proc.getHandler();
    if (!handler) {
      return new ProcedureError(500, 'Procedure has no handler');
    }

    const result = await handler(inputSafe.data);
    if (result.tag === 'defer') {
      // add the task to the deferred tasks
      console.log('adding task', result.deferrableTask.id);
      DeferredTasks.addTask(result.deferrableTask);
      result.deferrableTask.run();
      return new ProcedureDeferTask(result.status, result.deferrableTask);
    } else if (result.tag === 'json') {
      return result;
    } else if (result.tag === 'error') {
      return new ProcedureError(result.status, result.error);
    }
    return new ProcedureError(500, 'Unknown error');
  }
}
