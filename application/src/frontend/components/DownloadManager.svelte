<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import {
    createNotification,
    currentDownloads,
    failedSetups,
    type DownloadStatusAndInfo,
  } from "../store";
  import { getDownloadPath, safeFetch } from "../utils";

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }
  document.addEventListener("ddl:download-progress", (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    let downloadSpeed = event.detail.downloadSpeed;
    let fileSize = event.detail.fileSize;

    if (!fileSize) {
      fileSize = 0;
    }
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            progress,
            downloadSpeed,
            downloadSize: fileSize,
            totalParts: event.detail.totalParts,
            part: event.detail.part,
          };
        }
        return download;
      });
    });
  });

  document.addEventListener("torrent:download-progress", (event: Event) => {
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
            downloadSize: fileSize,
            ratio: event.detail.ratio,
          };
        }
        return download;
      });
    });
  });

  document.addEventListener(
    "torrent:download-complete",
    async (event: Event) => {
      if (!isCustomEvent(event)) return;
      const downloadID = event.detail.id;
      let downloadedItem: DownloadStatusAndInfo | undefined = undefined;
      currentDownloads.update((downloads) => {
        return downloads.map((download) => {
          if (download.id === downloadID) {
            downloadedItem = download;
            return {
              ...download,
              status: "completed",
            };
          }
          return download;
        });
      });
      if (downloadedItem === undefined) return;
      downloadedItem = downloadedItem as DownloadStatusAndInfo;

      // then, because it's a torrent, we need to get the directory within the download path
      let outputDir = downloadedItem.downloadPath;
      if (outputDir.endsWith(".torrent")) {
        const filesInDir = await window.electronAPI.fs.getFilesInDir(outputDir);
        if (filesInDir.length === 1) {
          outputDir = downloadedItem.downloadPath + "\\" + filesInDir[0] + "\\";
          console.log("Newly calculated outputDir: ", outputDir);
        } else {
          console.error(
            "Error: More than one file in the directory, cannot determine the output directory."
          );
        }
      }

      safeFetch(
        "http://localhost:7654/addons/" +
          downloadedItem.addonSource +
          "/setup-app",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: outputDir,
            type: downloadedItem.downloadType,
            name: downloadedItem.name,
            usedRealDebrid: downloadedItem.usedRealDebrid,
            appID: downloadedItem.appID,
            storefront: downloadedItem.storefront,
          }),
          onLogs: (log) => {
            document.dispatchEvent(
              new CustomEvent("setup:log", {
                detail: {
                  id: downloadedItem?.id,
                  log,
                },
              })
            );
          },
          onProgress: (progress) => {
            document.dispatchEvent(
              new CustomEvent("setup:progress", {
                detail: {
                  id: downloadedItem?.id,
                  progress,
                },
              })
            );
          },
          consume: "json",
        }
      )
        .then((data: LibraryInfo) => {
          if (downloadedItem === undefined) return;
          window.electronAPI.app.insertApp(data);
          currentDownloads.update((downloads) => {
            return downloads.map((download) => {
              if (download.id === downloadedItem?.id) {
                return {
                  ...download,
                  status: "seeding",
                  downloadPath: downloadedItem.downloadPath,
                };
              }
              return download;
            });
          });
        })
        .catch((error) => {
          console.error("Error setting up app: ", error);
          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: "error",
            message: "The addon had crashed while setting up.",
          });
          currentDownloads.update((downloads) => {
            return downloads.map((download) => {
              if (download.id === downloadedItem?.id) {
                return {
                  ...download,
                  status: "error",
                };
              }
              return download;
            });
          });
          saveFailedSetup({
            downloadInfo: downloadedItem,
            setupData: {
              path: outputDir,
              type: downloadedItem?.downloadType,
              name: downloadedItem?.name,
              usedRealDebrid: downloadedItem?.usedRealDebrid,
              appID: downloadedItem?.appID,
              storefront: downloadedItem?.storefront,
            },
            error: error.message,
            timestamp: Date.now(),
          });
        });
    }
  );

  document.addEventListener("ddl:download-complete", async (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    let downloadedItem: DownloadStatusAndInfo | undefined = undefined;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          downloadedItem = download;
          return {
            ...download,
            status: "completed",
          };
        }
        return download;
      });
    });
    if (downloadedItem === undefined) return;
    downloadedItem = downloadedItem as DownloadStatusAndInfo;

    if (downloadedItem.usedRealDebrid && !downloadedItem.files) {
      document.dispatchEvent(
        new CustomEvent("setup:log", {
          detail: {
            id: downloadedItem?.id,
            log: ["Extracting downloaded RAR file..."],
          },
        })
      );
      const outputDir = await window.electronAPI.fs.unrar({
        outputDir: getDownloadPath() + "/" + downloadedItem.filename,
        rarFilePath: downloadedItem.downloadPath,
      });
      downloadedItem.downloadPath = outputDir;
    }

    safeFetch(
      "http://localhost:7654/addons/" +
        downloadedItem.addonSource +
        "/setup-app",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: downloadedItem.downloadPath,
          type: downloadedItem.downloadType,
          name: downloadedItem.name,
          usedRealDebrid: downloadedItem.usedRealDebrid,
          multiPartFiles: downloadedItem.files,
          appID: downloadedItem.appID,
          storefront: downloadedItem.storefront,
        }),
        onLogs: (log) => {
          document.dispatchEvent(
            new CustomEvent("setup:log", {
              detail: {
                id: downloadedItem?.id,
                log,
              },
            })
          );
        },
        onProgress: (progress) => {
          document.dispatchEvent(
            new CustomEvent("setup:progress", {
              detail: {
                id: downloadedItem?.id,
                progress,
              },
            })
          );
        },
        consume: "json",
      }
    )
      .then((data: LibraryInfo) => {
        if (downloadedItem === undefined) return;
        window.electronAPI.app.insertApp(data);
        currentDownloads.update((downloads) => {
          return downloads.map((download) => {
            if (download.id === downloadedItem?.id) {
              return {
                ...download,
                status: "setup-complete",
                downloadPath: downloadedItem.downloadPath,
              };
            }
            return download;
          });
        });
      })
      .catch((error) => {
        console.error("Error setting up app: ", error);
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: "error",
          message: "The addon had crashed while setting up.",
        });
        currentDownloads.update((downloads) => {
          return downloads.map((download) => {
            if (download.id === downloadedItem?.id) {
              return {
                ...download,
                status: "error",
              };
            }
            return download;
          });
        });
        saveFailedSetup({
          downloadInfo: downloadedItem,
          setupData: {
            path: downloadedItem?.downloadPath,
            type: downloadedItem?.downloadType,
            name: downloadedItem?.name,
            usedRealDebrid: downloadedItem?.usedRealDebrid,
            multiPartFiles: downloadedItem?.files,
            appID: downloadedItem?.appID,
            storefront: downloadedItem?.storefront,
          },
          error: "Addon Failure",
          timestamp: Date.now(),
        });
      });
  });

  document.addEventListener("ddl:download-error", (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return {
            ...download,
            status: "error",
          };
        }
        return download;
      });
    });
  });

  function saveFailedSetup(setupInfo: any) {
    try {
      if (!window.electronAPI.fs.exists("./failed-setups")) {
        window.electronAPI.fs.mkdir("./failed-setups");
      }

      const failedSetupId = Math.random().toString(36).substring(7);
      const failedSetupData = {
        id: failedSetupId,
        timestamp: Date.now(),
        ...setupInfo,
        retryCount: 0,
      };

      window.electronAPI.fs.write(
        `./failed-setups/${failedSetupId}.json`,
        JSON.stringify(failedSetupData, null, 2)
      );

      failedSetups.update((setups) => {
        return [...setups, failedSetupData];
      });
      console.log("Saved failed setup info:", failedSetupId);
    } catch (error) {
      console.error("Failed to save setup info:", error);
    }
  }
</script>
