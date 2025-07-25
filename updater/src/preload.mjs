import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('text', (event, text, progress, max, subtext) => {
  document.dispatchEvent(
    new CustomEvent('text', { detail: { text, progress, max, subtext } })
  );
});
