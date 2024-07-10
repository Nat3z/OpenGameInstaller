<script lang="ts">
  import { currentDownloads } from "../store";

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }
  document.addEventListener('ddl:download-progress', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    const downloadSpeed = event.detail.downloadSpeed;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            progress,
            downloadSpeed
          }
        }
        return download;
      });
    });
  });

  document.addEventListener('ddl:download-complete', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            status: 'completed'
          }
        }
        return download;
      });
    });
  });

  document.addEventListener('ddl:download-error', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            status: 'error'
          }
        }
        return download;
      });
    });
  });

</script>