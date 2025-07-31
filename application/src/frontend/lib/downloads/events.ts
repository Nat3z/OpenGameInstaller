import type { DownloadStatusAndInfo } from '../../store';

export function listenUntilDownloadReady() {
  let state: { [id: string]: Partial<DownloadStatusAndInfo> } = {};
  const updateState = (e: Event) => {
    if (e instanceof CustomEvent) {
      if (e.detail) {
        state[e.detail.id] = e.detail as Partial<DownloadStatusAndInfo>;
      }
    }
  };
  document.addEventListener('ddl:download-progress', updateState);

  return {
    flush: () => {
      document.removeEventListener('ddl:download-progress', updateState);
      return state;
    },
  };
}
