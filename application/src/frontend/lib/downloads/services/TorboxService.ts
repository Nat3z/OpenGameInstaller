import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath, listenUntilDownloadReady } from '../../../utils';
import { getConfigClientOption } from '../../config/client';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { BaseService } from './BaseService';

const BASE_URL = 'https://api.torbox.app/v1';

type TorboxFile = {
  id: number;
  md5: string;
  s3_path: string;
  name: string;
  size: number;
  mimetype: string;
  short_name: string;
};

type TorboxTorrent = {
  id: number;
  hash: string;
  created_at: string;
  updated_at: string;
  magnet: string;
  size: number;
  active: boolean;
  auth_id: string;
  download_state: string;
  seeds: number;
  peers: number;
  ratio: number;
  progress: number;
  download_speed: number;
  upload_speed: number;
  name: string;
  eta: number;
  server: number;
  torrent_file: boolean;
  expires_at: string;
  download_present: boolean;
  download_finished: boolean;
  files: TorboxFile[];
  inactive_check: number;
  availability: number;
};

type TorboxTorrentListResponse = {
  success: boolean;
  error: string | null;
  detail: string;
  data: TorboxTorrent[];
};

export class TorboxService extends BaseService {
  readonly types = ['torbox-magnet', 'torbox-torrent'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    const optionHandled = getConfigClientOption<{ torboxApiKey?: string }>(
      'realdebrid'
    );
    if (!optionHandled || !optionHandled.torboxApiKey) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Please set your TorBox API key in the settings.',
      });
      return;
    }
    const { torboxApiKey } = optionHandled;
    const addTorrentForm = new FormData();

    // -- STEP 1: CREATE THE TORRENT ON TORBOX --

    let torrentHash = '';

    if (result.downloadType === 'torrent') {
      const torrentData = await window.electronAPI.downloadTorrentInto(
        result.downloadURL!
      );
      // with the torrent data, use in new FormData as a file
      addTorrentForm.append(
        'file',
        new Blob([torrentData.buffer as ArrayBuffer])
      );
      torrentHash = await window.electronAPI.getTorrentHash(torrentData);
    } else if (result.downloadType === 'magnet') {
      addTorrentForm.append('magnet', result.downloadURL!);
      torrentHash = await window.electronAPI.getTorrentHash(
        result.downloadURL!
      );
    }

    console.log('torrentHash: ', torrentHash);

    // seed to auto (the preference of the user)
    addTorrentForm.append('seed', '1');
    // alow the torrent output downloaded to be a zip file
    addTorrentForm.append('allow_zip', 'true');
    // instant in the queue
    addTorrentForm.append('as_queued', 'false');

    // Debug FormData contents
    console.log('addTorrentForm entries:');
    addTorrentForm.forEach((value, key) => {
      console.log('key: ', key);
      console.log('value: ', value);
    });

    const response = await window.electronAPI.app.axios<{
      success: boolean;
      error: string | null;
      detail: string;
      data:
        | {
            hash: string;
            queued_id?: number;
            torrent_id?: number;
          }
        | {
            cooldown_until: number;
          };
    }>({
      url: `${BASE_URL}/api/torrents/createtorrent`,
      method: 'post',
      data: Object.fromEntries(addTorrentForm.entries()),
      headers: {
        'Content-Type': 'multipart/form-data',
        Authorization: `Bearer ${torboxApiKey}`,
      },
    });

    // check if it worked then provide a good response message
    if (
      response.status !== 200 &&
      response.data.detail !== 'Download already queued.'
    ) {
      // get the error message from the data
      const errorMessage = response.data.detail;
      console.log('Failed to create torrent on Torbox: ', errorMessage);

      const message =
        response.data.error === 'DOWNLOAD_TOO_LARGE'
          ? 'Your current plan does not support the size you are trying to download.'
          : response.data.detail.includes('active torrent limit of')
            ? 'You have reached your active torrent limit.'
            : response.data.detail.includes(
                  'reached your monthly download limit'
                )
              ? 'You have reached your monthly download limit.'
              : response.data.detail.includes('cooldown')
                ? 'You are on a cooldown period. Please wait until ' +
                  new Date(
                    (response.data.data as { cooldown_until: number })
                      .cooldown_until * 1000
                  ).toLocaleString() +
                  ' to try again.'
                : response.data.detail.includes('must provide') &&
                    response.data.detail.includes('file or magnet')
                  ? 'Addon did not provide a valid file or magnet.'
                  : response.data.detail;

      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: message,
      });
      return;
    }
    console.log('response: ', response);

    // -- STEP 2: GET THE TORRENT ID --

    // check if there is a queued id or a torrent id
    const queued_id = (response.data.data as { queued_id?: number }).queued_id;
    let torrent_id = (response.data.data as { torrent_id?: number }).torrent_id;

    if (!queued_id && !torrent_id) {
      console.error('No queued id or torrent id found');
      return;
    }

    if (queued_id) {
      // -- STEP 2.5: GET THE TORRENT ID FROM THE QUEUED ID BY INSTANTLY STARTING IT --
      const startTorrentResponse = await window.electronAPI.app.axios({
        url: `${BASE_URL}/api/queued/controlqueued`,
        method: 'post',
        data: {
          queued_id: queued_id,
          operation: 'start',
          all: false,
        },
        headers: {
          Authorization: `Bearer ${torboxApiKey}`,
        },
      });

      if (startTorrentResponse.status !== 200) {
        console.error('startTorrentResponse: ', startTorrentResponse);
        console.error('Failed to start torrent');
        return;
      }
    }

    // -- STEP 3: WAIT FOR THE TORRENT TO BE READY  --
    // insert into the downloadItems array the temp id
    const tempId = this.queueRequestDownload(result, appID, 'torbox');

    // wait for the torrent to be on the dashboard
    console.log('torrentHash: ', torrentHash);
    const torrentGrabber = await new Promise<TorboxTorrent | undefined>(
      (resolve) => {
        const startTime = Date.now();
        const timeoutMs = 650 * 1000; // 650 seconds
        const interval = setInterval(async () => {
          // Check for timeout
          if (Date.now() - startTime > timeoutMs) {
            clearInterval(interval);
            console.error(
              'Timeout: Torrent did not appear in mylist within 60 seconds'
            );
            resolve(undefined);
            return;
          }

          const torrentInfo =
            await window.electronAPI.app.axios<TorboxTorrentListResponse>({
              url: `${BASE_URL}/api/torrents/mylist`,
              method: 'get',
              headers: {
                Authorization: `Bearer ${torboxApiKey}`,
              },
            });

          if (!torrentInfo.data.success) {
            console.error('Failed to get torrent list');
            return;
          }
          console.log('torrentInfo.data.data: ', torrentInfo.data.data);

          const torrent = torrentInfo.data.data.find(
            (torrent) => torrent.hash === torrentHash
          );

          if (!torrent) {
            console.error('Torrent not found in mylist');
            return;
          }

          if (torrent.download_finished) {
            clearInterval(interval);
            resolve(torrent);
            return;
          }
        }, 3000);
      }
    );

    torrent_id = torrentGrabber?.id;

    if (torrent_id) {
      // -- STEP 4: DOWNLOAD THE TORRENT --
      const url = new URL(`${BASE_URL}/api/torrents/requestdl`);
      url.searchParams.set('token', torboxApiKey);
      url.searchParams.set('torrent_id', torrent_id!.toString());
      url.searchParams.set('zip_link', 'true');
      url.searchParams.set('redirect', 'true');

      // generate the whole url
      const downloadUrl = url.toString();
      console.log('Final Torbox download URL: ', downloadUrl);

      const { flush } = listenUntilDownloadReady();
      const downloadID = await window.electronAPI.ddl.download([
        {
          link: downloadUrl,
          path:
            getDownloadPath() +
            '/' +
            result.name +
            '/' +
            result.filename! +
            '.zip',
        },
      ]);
      const updatedState = flush();
      if (downloadID === null) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Failed to download the torrent.',
        });
        currentDownloads.update((downloads) => {
          return downloads.filter((download) => download.id !== tempId);
        });
        return;
      }

      console.log('updatedState: ', updatedState);
      this.updateDownloadRequested(
        downloadID,
        tempId,
        downloadUrl,
        getDownloadPath() + '/' + result.name + '/' + result.filename + '.zip',
        'torbox',
        updatedState,
        result
      );
    }
  }
}
