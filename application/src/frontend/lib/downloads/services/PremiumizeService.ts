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
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    let originalText = '';
    let originalDisabled = false;

    if (htmlButton) {
      originalText = htmlButton.textContent || '';
      originalDisabled = htmlButton.disabled;
      htmlButton.textContent = 'Downloading...';
      htmlButton.disabled = true;
    }

    try {
      console.log('PremiumizeService startDownload', result);
      const optionHandled = getConfigClientOption<{ premiumizeApiKey?: string }>(
        'premiumize'
      );
      if (!optionHandled || !optionHandled.premiumizeApiKey) {
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
          throw new Error('OpenGameInstaller folder not found in Premiumize');
        }
      } else if (responseFolderContentData.status === 'error') {
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
        data: formDataAddTorrent,
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

    if (responseAddTorrent.data.status === 'error') {
      throw new Error(responseAddTorrent.data.message);
    }
    const transferId = responseAddTorrent.data.id;
    console.log('Transfer ID: ', transferId);

    // -- Step 3: Wait for the torrent to be ready --
    const foundFolderId = await new Promise<string>((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(async () => {
        try {
          if (attempts > 120) { // 120 * 2.5s = 5 minutes (adjust if needed, but 10 mins is standard)
            clearInterval(interval);
            reject(new Error('Timed out waiting for Premiumize transfer.'));
            return;
          }
          const responseTransfersList =
            await window.electronAPI.app.axios<PremiumizeTransfersListResponse>({
              method: 'GET',
              url: `${BASE_URL}/transfer/list?apikey=${premiumizeApiKey}`,
            });
          if (responseTransfersList.status !== 200) {
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
          attempts++;
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 2500);
    });

    if (!foundFolderId) {
      throw new Error('Failed to download torrent from Premiumize');
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
      console.log('Response: ', responseTorrentFile);
      throw new Error('Failed to get direct download from Premiumize');
    }

    if (responseTorrentFile.data.status === 'error') {
      console.log('Response: ', responseTorrentFile.data);
      throw new Error(responseTorrentFile.data.message);
    }

    const directDownloadUrl = responseTorrentFile.data.location;
    console.log('Direct download URL: ', directDownloadUrl);

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
          result.filename +
          '.zip',
        headers: {
          'OGI-Parallel-Limit': '1',
        },
      },
    ]);
    const updatedState = flush();
    if (downloadID === null) {
      throw new Error('Failed to download the torrent.');
    }

    this.updateDownloadRequested(
      downloadID,
      tempId,
      directDownloadUrl,
      getDownloadPath() + '/' + result.name + '/' + result.filename + '.zip',
      'premiumize',
      updatedState,
      result
    );
    } finally {
      if (htmlButton) {
        htmlButton.textContent = originalText;
        htmlButton.disabled = originalDisabled;
      }
    }
  }
}
