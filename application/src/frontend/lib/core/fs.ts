import { createNotification } from '../../store';

export function getDownloadPath(): string {
  if (!window.electronAPI.fs.exists('./config/option/general.json')) {
    if (!window.electronAPI.fs.exists('./downloads'))
      window.electronAPI.fs.mkdir('./downloads');
    createNotification({
      message: 'Download path not set, using default path (./downloads)',
      id: 'download-path',
      type: 'info',
    });
    return './downloads';
  }
  if (!window.electronAPI.fs.exists('./downloads'))
    window.electronAPI.fs.mkdir('./downloads');
  const file = window.electronAPI.fs.read('./config/option/general.json');
  const data = JSON.parse(file);
  return data.fileDownloadLocation;
}

export async function fsCheck(path: string) {
  try {
    return window.electronAPI.fs.exists(path);
  } catch (e) {
    return false;
  }
}
