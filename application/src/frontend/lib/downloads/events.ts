import type { DownloadStatusAndInfo } from '@/frontend/store';

export function listenUntilDownloadReady(
  channels: string[] = ['ddl:download-progress', 'ddl:download-error']
) {
  let state: { [id: string]: Partial<DownloadStatusAndInfo> } = {};
  const updateState = (e: Event) => {
    if (e instanceof CustomEvent) {
      if (e.detail) {
        state[e.detail.id] = e.detail as Partial<DownloadStatusAndInfo>;
      }
    }
  };
  channels.forEach((channel) =>
    document.addEventListener(channel, updateState)
  );

  return {
    flush: () => {
      channels.forEach((channel) =>
        document.removeEventListener(channel, updateState)
      );
      return state;
    },
  };
}
