import { contextBridge, ipcRenderer } from 'electron';
import type { UpdaterStatusPayload } from './status.js';

type StatusListener = (payload: UpdaterStatusPayload) => void;
type ChannelPickerListener = () => void;

contextBridge.exposeInMainWorld('ogiUpdater', {
  chooseChannel: (channel, commit, branch) =>
    ipcRenderer.send('choose-channel', { channel, commit, branch }),
  getBranches: () => ipcRenderer.invoke('get-branches'),
  getRecentCommits: (branch) =>
    ipcRenderer.invoke('get-recent-commits', branch),
  onStatus: (listener: StatusListener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: UpdaterStatusPayload
    ) => listener(payload);
    ipcRenderer.on('updater-status', handler);
    return () => ipcRenderer.removeListener('updater-status', handler);
  },
  onShowChannelPicker: (listener: ChannelPickerListener) => {
    const handler = () => listener();
    ipcRenderer.on('show-channel-picker', handler);
    return () => ipcRenderer.removeListener('show-channel-picker', handler);
  },
});
