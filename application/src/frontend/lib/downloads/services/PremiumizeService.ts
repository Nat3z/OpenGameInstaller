import { createNotification } from '../../../store';
import {
  getConfigClientOption,
  getDownloadPath,
  listenUntilDownloadReady,
} from '../../../utils';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { BaseService } from './BaseService';

const BASE_URL = 'https://www.premiumize.me/api';

type ResponseFolder =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      id: string;
      message?: string;
    };
type PremiumizeFolderContentItem = {
  id: string;
  name: string;
  type: string;
  created_at: number;
};

type PremiumizeErrorResponse = {
  status: 'error';
  message: string;
};

type PremiumizeFolderResponse =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      content: PremiumizeFolderContentItem[];
      name: string;
      parent_id: string;
      folder_id: string;
    };

type PremiumizeTransferResponse =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      id: string;
      name: string;
      type: string;
    };

type PremiumizeTransfersListResponse =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      transfers: Array<{
        id: string;
        name: string;
        message: string;
        status: 'finished' | 'waiting';
        progress: number;
        src: string;
        folder_id: string;
        file_id: string;
      }>;
    };

type PremiumizeZipGenerateResponse =
  | PremiumizeErrorResponse
  | { status: 'success'; location: string };

export class PremiumizeService extends BaseService {
  readonly types = ['premiumize-magnet', 'premiumize-torrent'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    _event: MouseEvent | null,
    _htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    console.log('PremiumizeService startDownload', result);
    const optionHandled = getConfigClientOption<{ premiumizeApiKey?: string }>(
      'premiumize'
    );
    if (!optionHandled || !optionHandled.premiumizeApiKey) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Please set your Premiumize API key in the settings.',
      });
      throw new Error('Please set your Premiumize API key in the settings.');
    }
    const { premiumizeApiKey } = optionHandled;

    const tempId = this.queueRequestDownload(result, appID, 'premiumize');

    // create the opengameinstaller folder on premiumize

    let folderId = '';

    const responseFolder = await window.electronAPI.app.axios({
      method: 'POST',
      url: `${BASE_URL}/folder/create?apikey=${premiumizeApiKey}`,
      data: {
        name: 'OpenGameInstaller',
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    // -- Step 1: Create the folder for OGI to download to --
    const responseFolderData = responseFolder.data as ResponseFolder;
    if (responseFolderData.status === 'success') {
      folderId = responseFolderData.id;
    } else if (responseFolderData.status === 'error') {
      // get the folder from the root
      const responseFolderContent = await window.electronAPI.app.axios({
        method: 'GET',
        url: `${BASE_URL}/folder/content?apikey=${premiumizeApiKey}`,
      });

      const responseFolderContentData =
        responseFolderContent.data as PremiumizeFolderResponse;
      if (responseFolderContentData.status === 'success') {
        const folder = responseFolderContentData.content.find(
          (item) => item.name === 'OpenGameInstaller'
        );
        if (folder) {
          folderId = folder.id;
        } else {
          createNotification({
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message: 'OpenGameInstaller folder not found in Premiumize',
          });
          throw new Error('OpenGameInstaller folder not found in Premiumize');
        }
      } else if (responseFolderContentData.status === 'error') {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: responseFolderContentData.message,
        });
        throw new Error(responseFolderContentData.message);
      }
    }

    // -- Step 2: Add the torrent to the folder --
    const formDataAddTorrent = new FormData();
    if (result.downloadType === 'torrent') {
      const torrentData = await window.electronAPI.downloadTorrentInto(
        result.downloadURL!
      );
      formDataAddTorrent.append(
        'file',
        new Blob([torrentData.buffer as ArrayBuffer])
      );
    } else if (result.downloadType === 'magnet') {
      formDataAddTorrent.append('src', result.downloadURL!);
    }
    formDataAddTorrent.append('folder_id', folderId);

    const responseAddTorrent =
      await window.electronAPI.app.axios<PremiumizeTransferResponse>({
        method: 'POST',
        url: `${BASE_URL}/transfer/create?apikey=${premiumizeApiKey}`,
        data: Object.fromEntries(formDataAddTorrent.entries()),
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

    if (responseAddTorrent.data.status === 'error') {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to add torrent to Premiumize',
      });
      throw new Error(responseAddTorrent.data.message);
    }
    const transferId = responseAddTorrent.data.id;
    console.log('Transfer ID: ', transferId);

    // -- Step 3: Wait for the torrent to be ready --
    const foundFolderId = await new Promise<string>((resolve) => {
      let attempts = 0;
      const interval = setInterval(async () => {
        if (attempts > 10) {
          clearInterval(interval);
          resolve('');
          return;
        }
        const responseTransfersList =
          await window.electronAPI.app.axios<PremiumizeTransfersListResponse>({
            method: 'GET',
            url: `${BASE_URL}/transfer/list?apikey=${premiumizeApiKey}`,
          });
        if (responseTransfersList.status !== 200) {
          createNotification({
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message: 'Failed to get transfers list from Premiumize',
          });
          attempts++;
          return;
        }
        if (responseTransfersList.data.status === 'error') {
          attempts++;
          return;
        }
        const transfer = responseTransfersList.data.transfers.find(
          (transfer) => transfer.id === transferId
        );
        if (transfer?.status === 'finished') {
          clearInterval(interval);
          resolve(transfer?.folder_id || '');
          return;
        }
      }, 2500);
    });

    if (!foundFolderId) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to download torrent from Premiumize',
      });
    }

    // -- Step 4: Get the direct download --
    const responseTorrentFile =
      await window.electronAPI.app.axios<PremiumizeZipGenerateResponse>({
        method: 'POST',
        url: `${BASE_URL}/zip/generate?apikey=${premiumizeApiKey}`,
        data: {
          'folders[]': foundFolderId,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

    if (responseTorrentFile.status !== 200) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to get direct download from Premiumize',
      });
      console.log('Response: ', responseTorrentFile);
      throw new Error('Failed to get direct download from Premiumize');
    }

    if (responseTorrentFile.data.status === 'error') {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to get direct download from Premiumize',
      });
      console.log('Response: ', responseTorrentFile.data);
      throw new Error(responseTorrentFile.data.message);
    }

    const directDownloadUrl = responseTorrentFile.data.location;
    console.log('Direct download URL: ', directDownloadUrl);

    const safeFilename =
      result.filename ?? result.name ?? 'premiumize_download';

    // -- Step 5: Send the direct download to the download handler --
    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      {
        link: directDownloadUrl,
        path:
          getDownloadPath() +
          '/' +
          result.name +
          '/' +
          safeFilename +
          '.zip',
        headers: {
          'OGI-Parallel-Limit': '1',
        },
      },
    ]);
    const updatedState = flush();
    if (downloadID === null) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to download the torrent.',
      });
    }

    this.updateDownloadRequested(
      downloadID,
      tempId,
      directDownloadUrl,
      getDownloadPath() + '/' + result.name + '/' + safeFilename + '.zip',
      'premiumize',
      updatedState,
      result
    );
  }
}
