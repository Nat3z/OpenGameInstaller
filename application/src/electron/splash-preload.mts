import { ipcRenderer } from 'electron';

ipcRenderer.on('splash-status', (_, text) => {
  document.dispatchEvent(
    new CustomEvent('splash-status', { detail: { text } })
  );
});
