import {
  createNotification,
  currentDownloads,
  failedSetups,
  setupLogs,
  type FailedSetup,
} from '../../store';
import { getDownloadPath } from '../core/fs';
import { safeFetch } from '../core/ipc';

export async function loadFailedSetups() {
  try {
    if (!window.electronAPI.fs.exists('./failed-setups')) {
      window.electronAPI.fs.mkdir('./failed-setups');
      return;
    }

    const files = await window.electronAPI.fs.getFilesInDir('./failed-setups');
    const loadedSetups: FailedSetup[] = [];

    files.forEach((file: string) => {
      if (file.endsWith('.json')) {
        try {
          const content = window.electronAPI.fs.read(`./failed-setups/${file}`);
          const setupData = JSON.parse(content);
          loadedSetups.push(setupData);
        } catch (error) {
          console.error('Error loading failed setup file:', file, error);
        }
      }
    });

    console.log('loadedSetups', loadedSetups);
    failedSetups.set(loadedSetups);
  } catch (error) {
    console.error('Error loading failed setups:', error);
  }
}

export function removeFailedSetup(setupId: string) {
  try {
    const filePath = `./failed-setups/${setupId}.json`;
    if (window.electronAPI.fs.exists(filePath)) {
      window.electronAPI.fs.delete(filePath);
    }

    failedSetups.update((setups) =>
      setups.filter((setup) => setup.id !== setupId)
    );
  } catch (error) {
    console.error('Error removing failed setup:', error);
  }
}

export async function retryFailedSetup(failedSetup: FailedSetup) {
  const updateRetry = (newSetup: FailedSetup, error: string) => {
    const updatedSetup = {
      ...newSetup,
      retryCount: newSetup.retryCount + 1,
      error: error as string,
    };

    window.electronAPI.fs.write(
      `./failed-setups/${newSetup.id}.json`,
      JSON.stringify(updatedSetup, null, 2)
    );

    failedSetups.update((setups) =>
      setups.map((setup) => (setup.id === newSetup.id ? updatedSetup : setup))
    );
  };

  try {
    console.log('Retrying setup for:', failedSetup.downloadInfo.name);

    const setupData = failedSetup.setupData;
    console.log('setupData', setupData);
    const addonSource = failedSetup.downloadInfo.addonSource;

    // Create a temporary download entry to show progress
    const tempId = Math.random().toString(36).substring(7);
    currentDownloads.update((downloads) => {
      return [
        ...downloads,
        {
          ...failedSetup.downloadInfo,
          id: tempId,
          status: 'completed' as const,
        },
      ];
    });
    if (failedSetup.should === 'call-unrar') {
      console.log(
        'Unrarring RAR file: ',
        failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.filename,
        'to',
        getDownloadPath() + '/' + failedSetup.downloadInfo.name
      );
      const extractedDir = await window.electronAPI.fs.unrar({
        outputDir:
          failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.name,
        rarFilePath:
          failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.filename,
      });
      setupData.path = extractedDir;
      // delete the rar file
      console.log('Deleting RAR file: ', failedSetup.downloadInfo.downloadPath);
      window.electronAPI.fs.delete(failedSetup.downloadInfo.downloadPath);
      console.log('RAR file deleted');
      failedSetup.downloadInfo.downloadPath = extractedDir;
      failedSetup.setupData.path = extractedDir;
      failedSetup.should = 'call-addon';
    }

    if (failedSetup.should === 'call-unzip') {
      console.log(
        'Extracting ZIP file: ',
        failedSetup.downloadInfo.downloadPath,
        'to',
        failedSetup.downloadInfo.downloadPath
      );
      const extractedDir = await window.electronAPI.fs.unzip({
        zipFilePath: failedSetup.downloadInfo.downloadPath,
        outputDir: failedSetup.downloadInfo.downloadPath,
      });
      setupData.path = extractedDir;
      console.log('ZIP file extracted successfully');
      failedSetup.downloadInfo.downloadPath = extractedDir;
      failedSetup.setupData.path = extractedDir;
      failedSetup.should = 'call-addon';
    }

    // now add to setup logs
    setupLogs.update((logs) => ({
      ...logs,
      [tempId]: {
        downloadId: tempId,
        logs: [],
        progress: 0,
        isActive: true,
      },
    }));

    // Attempt the setup again
    safeFetch(
      'setupApp',
      {
        addonID: addonSource,
        ...setupData,
      },
      {
        onLogs: (logs: string[]) => {
          document.dispatchEvent(
            new CustomEvent('setup:log', {
              detail: {
                id: tempId,
                log: logs,
              },
            })
          );
        },
        onProgress: (progress: number) => {
          document.dispatchEvent(
            new CustomEvent('setup:progress', {
              detail: {
                id: tempId,
                progress,
              },
            })
          );
        },
        consume: 'json',
      }
    )
      .then(
        (
          result: Omit<
            LibraryInfo,
            | 'capsuleImage'
            | 'coverImage'
            | 'name'
            | 'appID'
            | 'storefront'
            | 'addonsource'
          >
        ) => {
          window.electronAPI.app.insertApp({
            ...result,
            capsuleImage: failedSetup.downloadInfo.capsuleImage,
            coverImage: failedSetup.downloadInfo.coverImage,
            name: failedSetup.downloadInfo.name,
            appID: failedSetup.downloadInfo.appID,
            storefront: failedSetup.downloadInfo.storefront,
            addonsource: failedSetup.downloadInfo.addonSource,
          });
          removeFailedSetup(failedSetup.id);
          // Update the temporary download entry to show completion
          currentDownloads.update((downloads) => {
            return downloads.map((download) => {
              if (download.id === tempId) {
                return {
                  ...download,
                  status: 'setup-complete' as const,
                };
              }
              return download;
            });
          });
          createNotification({
            id: Math.random().toString(36).substring(7),
            type: 'success',
            message: `Successfully set up ${failedSetup.downloadInfo.name}`,
          });
        }
      )
      .catch((error) => {
        console.error('Error retrying setup:', error);
        currentDownloads.update((downloads) => {
          return downloads.filter((download) => download.id !== tempId);
        });
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
        });

        updateRetry(failedSetup, error);
      });
  } catch (error: unknown) {
    console.error('Error retrying setup:', error);

    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'error',
      message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
    });

    updateRetry(failedSetup, error as string);
  }
}
