import {
  createNotification,
  currentDownloads,
  failedSetups,
  setupLogs,
  type FailedSetup,
  type DownloadStatusAndInfo,
} from '../../store';
// safeFetch not used here; setup is executed via runSetupApp
import type { EventListenerTypes } from 'ogi-addon';
import {
  unrarAndReturnOutputDir,
  unzipAndReturnOutputDir,
} from '../setup/extraction';
import { runSetupApp } from '../setup/setup';

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

export function saveFailedSetup(setupInfo: {
  downloadInfo: DownloadStatusAndInfo;
  setupData: Parameters<EventListenerTypes['setup']>[0];
  error: string;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
}) {
  try {
    if (!window.electronAPI.fs.exists('./failed-setups')) {
      window.electronAPI.fs.mkdir('./failed-setups');
    }

    const failedSetupId = Math.random().toString(36).substring(7);
    const failedSetupData: FailedSetup = {
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
    console.log('Saved failed setup info:', failedSetupId);
  } catch (error) {
    console.error('Failed to save setup info:', error);
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
    // const addonSource = failedSetup.downloadInfo.addonSource;

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
      const rarFilePath =
        failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
        '/' +
        failedSetup.downloadInfo.filename;
      const outputBase =
        failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
        '/' +
        failedSetup.downloadInfo.name;
      const extractedDir = await unrarAndReturnOutputDir({
        rarFilePath,
        outputBaseDir: outputBase,
        downloadId: tempId,
      });
      setupData.path = extractedDir;
      failedSetup.downloadInfo.downloadPath = extractedDir;
      failedSetup.setupData.path = extractedDir;
      failedSetup.should = 'call-addon';
    }

    if (failedSetup.should === 'call-unzip') {
      const originalZipFilePath = failedSetup.downloadInfo.downloadPath;
      const attemptUnzip: () => Promise<string | undefined> = async () => {
        const output = await unzipAndReturnOutputDir({
          zipFilePath: originalZipFilePath,
          outputDirBase: originalZipFilePath.replace(/\.zip$/g, ''),
          downloadId: tempId,
        });
        if (!output) return undefined;
        return output;
      };

      let outputDir: string | undefined;
      for (let i = 0; i < 3; i++) {
        try {
          outputDir = await attemptUnzip();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.log('Failed to extract ZIP file');
          console.error('Failed to process ZIP file: ', error);
          throw error;
        }
      }

      if (!outputDir) {
        throw new Error('Failed to extract ZIP file after 3 attempts');
      }

      failedSetup.downloadInfo.downloadPath = outputDir;
      setupData.path = failedSetup.downloadInfo.downloadPath;
      failedSetup.setupData.path = failedSetup.downloadInfo.downloadPath;
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

    try {
      await runSetupApp(
        {
          ...failedSetup.downloadInfo,
          id: tempId,
        },
        setupData.path,
        failedSetup.downloadInfo.downloadType === 'torrent' ||
          failedSetup.downloadInfo.downloadType === 'magnet'
      );
      removeFailedSetup(failedSetup.id);
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'success',
        message: `Successfully set up ${failedSetup.downloadInfo.name}`,
      });
    } catch (error) {
      console.error('Error retrying setup:', error);
      currentDownloads.update((downloads) => {
        return downloads.filter((download) => download.id !== tempId);
      });
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
      });
      updateRetry(failedSetup, error as string);
    }
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
