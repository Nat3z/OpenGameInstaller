import { ipcMain } from "electron";

export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('addon:request', async (event, request) => {
    event.sender.send
  });
}