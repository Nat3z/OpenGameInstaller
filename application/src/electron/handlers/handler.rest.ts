import { ipcMain } from 'electron';
import { addonServer } from '../server/addon-server.js';
import { requestSchema } from '../server/serve.js';

export default function handler() {
  ipcMain.handle('addon:request', async (_, request) => {
    const parsedRequestSafe = requestSchema.safeParse(request);
    if (!parsedRequestSafe.success) {
      return {
        error: 'Invalid request',
      };
    }

    const parsedRequest = parsedRequestSafe.data;
    const response = await addonServer.handleRequest(parsedRequest);
    if (response.tag === 'defer') {
      return {
        status: response.status,
        taskID: response.deferrableTask.id,
      };
    } else if (response.tag === 'json') {
      return {
        status: response.status,
        data: response.data,
      };
    } else if (response.tag === 'error') {
      return {
        status: response.status,
        error: response.error,
      };
    }
    return {
      error: 'Unknown error',
    };
  });
}
