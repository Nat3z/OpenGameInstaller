import { z } from 'zod';
import { DeferrableTask, DeferredTasks } from './DeferrableTask.js';
export class ProcedureReturnType {
    tag;
    status;
    constructor(tag, status) {
        this.tag = tag;
        this.status = status;
    }
}
export class ProcedureDeferTask extends ProcedureReturnType {
    deferrableTask;
    constructor(status, deferrableTask) {
        super('defer', status);
        this.deferrableTask = deferrableTask;
    }
}
export class ProcedureJSON extends ProcedureReturnType {
    data;
    constructor(status, data) {
        super('json', status);
        this.data = data;
    }
}
export class ProcedureError extends ProcedureReturnType {
    error;
    constructor(status, error) {
        super('error', status);
        this.error = error;
    }
}
export const requestSchema = z.object({
    method: z.string(),
    params: z.unknown(),
});
export class Procedure {
    inputSchema;
    handlerFn;
    input(schema) {
        const newProcedure = new Procedure();
        newProcedure.inputSchema = schema;
        return newProcedure;
    }
    handler(handler) {
        this.handlerFn = handler;
        return this;
    }
    getInputSchema() {
        return this.inputSchema;
    }
    getHandler() {
        return this.handlerFn;
    }
}
export const procedure = () => {
    return new Procedure();
};
export class AddonServer {
    procedures = {};
    registerProcedure(name, proc) {
        this.procedures[name] = proc;
    }
    constructor(procedures) {
        this.procedures = procedures;
    }
    async handleRequest(request) {
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
            return new ProcedureError(400, 'Invalid input');
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
        }
        else if (result.tag === 'json') {
            return result;
        }
        else if (result.tag === 'error') {
            return new ProcedureError(result.status, result.error);
        }
        return new ProcedureError(500, 'Unknown error');
    }
}
//# sourceMappingURL=serve.js.map