import { ipcMain } from 'electron';
import { z } from 'zod';
import { addonServer } from '../server/addon-server';
import { requestSchema } from '../server/serve';

export default function handler(mainWindow: Electron.BrowserWindow) {
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
        taskID: response.taskID,
      };
    } else if (response.tag === 'json') {
      return {
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
