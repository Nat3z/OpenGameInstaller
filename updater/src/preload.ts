import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('text', (event, text, progress, max, subtext) => {
  document.dispatchEvent(
    new CustomEvent('text', { detail: { text, progress, max, subtext } })
  );
});

ipcRenderer.on('show-channel-picker', () => {
  document.dispatchEvent(new CustomEvent('show-channel-picker'));
});

contextBridge.exposeInMainWorld('ogiUpdater', {
  chooseChannel: (channel, commit, branch) =>
    ipcRenderer.send('choose-channel', { channel, commit, branch }),
  getBranches: () => ipcRenderer.invoke('get-branches'),
  getRecentCommits: (branch) => ipcRenderer.invoke('get-recent-commits', branch),
});
