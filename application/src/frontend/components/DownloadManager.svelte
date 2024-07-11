<script lang="ts">
  import { currentDownloads, type DownloadStatusAndInfo } from "../store";
  import { safeFetch } from "../utils";

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }
  document.addEventListener('ddl:download-progress', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    const downloadSpeed = event.detail.downloadSpeed;
    const fileSize = event.detail.fileSize;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            progress,
            downloadSpeed,
            downloadSize: fileSize
          }
        }
        return download;
      });
    });
  });

  document.addEventListener('ddl:download-complete', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    let downloadedItem: DownloadStatusAndInfo | undefined = undefined;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          downloadedItem = download;
          return {
            ...download,
            status: 'completed'
          }
        }
        return download;
      });
    });
    if (downloadedItem === undefined) return;
    downloadedItem = downloadedItem as DownloadStatusAndInfo;

    safeFetch("http://localhost:7654/addons/" + downloadedItem.addonSource + "/setup-app", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path: downloadedItem.downloadPath
      }),
      onLogs: (log) => {
        document.dispatchEvent(new CustomEvent('setup:log', {
          detail: {
            id: downloadedItem?.id,
            log
          }
        }));
      },
      onProgress: (progress) => {
        document.dispatchEvent(new CustomEvent('setup:progress', {
          detail: {
            id: downloadedItem?.id,
            progress
          }
        }));
      },
      consume: "text"
    }).then((data) => {
      if (downloadedItem === undefined) return;
      if (data === "success") {
        currentDownloads.update((downloads) => {
          return downloads.map((download) => {
            if (download.id === downloadedItem?.id) {
              return {
                ...download,
                status: 'setup-complete'
              }
            }
            return download;
          });
        });
      } else {
        currentDownloads.update((downloads) => {
          return downloads.map((download) => {
            if (download.id === downloadedItem?.id) {
              return {
                ...download,
                status: 'error'
              }
            }
            return download;
          });
        });
      }
    })
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