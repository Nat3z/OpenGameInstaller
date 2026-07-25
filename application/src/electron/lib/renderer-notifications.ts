import { BrowserWindow } from 'electron';

export interface RendererNotification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}

export function sendNotification(notification: RendererNotification) {
  sendIPCMessage('notification', notification);
}

export function sendIPCMessage(channel: string, ...args: unknown[]) {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed()
  );
  window?.webContents.send(channel, ...args);
}
