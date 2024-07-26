import webtorrent from 'webtorrent';

const client = new webtorrent();

/**
 * Pass in a torrentID and path to download the torrent file.
 * @param {string} torrentId 
 * @param {string} path 
 * @param {(downloadTotal: number, speed: number, progress: number) => void} onProgress
 * @param {() => void} onDone
 * @returns {Promise<void>}
 */
function addTorrent(torrentId, path, onProgress, onDone) {
  return new Promise((resolve, reject) => {
    client.add(torrentId, { path },  async (torrent) => {
      // Torrents can contain many files. Download the first one.
      const file = torrent.files[0];
      torrent.on('download', () => {
        const downloadTotal = torrent.downloaded;
        const speed = torrent.downloadSpeed;
        const progress = torrent.progress;
        onProgress(downloadTotal, speed, progress);
      });
      torrent.on('done', async () => {
        onDone();
        resolve();
      });

    });
  });
}

/**
 * Pass in a buffer
 * @param {Buffer} buffer
 * @returns {Promise<void>}
 */
function seedTorrent(buffer) {
  return new Promise((resolve, reject) => {
    client.seed(buffer, (torrent) => {
      resolve()
    });
  });
}

/**
 * @returns {Promise<void>}
 */
async function stopClient() {
  return new Promise(async (resolve) => {
    await client.destroy();
  });
}

export { addTorrent, seedTorrent, stopClient };