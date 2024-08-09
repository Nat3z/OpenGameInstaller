import { ipcRenderer } from 'electron';

ipcRenderer.on('text', (_, text, progress, max, subtext) => {
  document.dispatchEvent(new CustomEvent('text', { detail: { text, progress, max, subtext } }));
})