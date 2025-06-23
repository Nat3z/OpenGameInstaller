import { z } from 'zod';

export class ProcedureReturnType<tag = string> {
  public tag: tag;
  constructor(tag: tag) {
    this.tag = tag;
  }
}

export class ProcedureDeferTask extends ProcedureReturnType<'defer'> {
  public taskID: string;
  constructor(taskID: string) {
    super('defer');
    this.taskID = taskID;
  }
}

export class ProcedureJSON<T> extends ProcedureReturnType<'json'> {
  public data: T;
  constructor(data: T) {
    super('json');
    this.data = data;
  }
}

export class ProcedureError extends ProcedureReturnType<'error'> {
  public error: string;
  public status: number;
  constructor(status: number, error: string) {
    super('error');
    this.status = status;
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

export function procedure<TInput = unknown>() {
  return new Procedure<TInput>();
}

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

export class AddonServer {
  private procedures: Record<string, Procedure> = {};

  public registerProcedure(name: string, procedure: Procedure) {
    this.procedures[name] = procedure;
  }

  constructor(procedures: Record<string, Procedure>) {
    this.procedures = procedures;
  }

  public async handleRequest(request: ProcedureRequest) {
    const procedure = this.procedures[request.method];
    if (!procedure) {
      return new ProcedureError(404, 'Procedure not found');
    }
    const inputSchema = procedure.getInputSchema();
    if (!inputSchema) {
      return new ProcedureError(400, 'Procedure has no input schema');
    }

    const inputSafe = inputSchema.safeParse(request.params);
    if (!inputSafe.success) {
      return new ProcedureError(400, 'Invalid input');
    }

    const handler = procedure.getHandler();
    if (!handler) {
      return new ProcedureError(500, 'Procedure has no handler');
    }

    const result = await handler(inputSafe.data);
    if (result.tag === 'defer') {
      return new ProcedureDeferTask(result.taskID);
    } else if (result.tag === 'json') {
      return result;
    } else if (result.tag === 'error') {
      return new ProcedureError(result.status, result.error);
    }
    return new ProcedureError(500, 'Unknown error');
  }
}
