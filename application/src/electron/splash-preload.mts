import { ipcRenderer } from 'electron';

ipcRenderer.on('splash-status', (_, text, subtext) => {
  document.dispatchEvent(
    new CustomEvent('splash-status', { detail: { text, subtext } })
  );
});

ipcRenderer.on('splash-progress', (_, current, total, speed) => {
  document.dispatchEvent(
    new CustomEvent('splash-progress', { detail: { current, total, speed } })
  );
});
