/**
 * AllDebrid IPC handlers: API key, user info, hosts, add magnet/torrent,
 * readiness check, torrent info, unrestrict link. Uses unique temp paths
 * and cleans up streams on all code paths.
 */
import { ipcMain } from 'electron';
import { sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import AllDebrid from 'all-debrid-js';
import { ReadStream } from 'original-fs';
import { __dirname } from '../manager/manager.paths.js';
import axios from 'axios';
const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');
let allDebridClient = new AllDebrid({
    apiKey: 'UNSET',
});
/**
 * Reads the AllDebrid API key from the realdebrid config file.
 * @returns The API key or null if missing or invalid.
 */
function readAlldebridKey() {
    if (!fs.existsSync(CONFIG_PATH))
        return null;
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const json = JSON.parse(raw);
        return json.alldebridApiKey ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Registers IPC handlers for AllDebrid: set key, update key, user info, hosts,
 * add magnet/torrent, readiness check, get torrent info, unrestrict link, select torrent.
 */
export default function handler(_mainWindow) {
    ipcMain.handle('all-debrid:set-key', async (_, arg) => {
        allDebridClient = new AllDebrid({ apiKey: arg });
        return 'success';
    });
    ipcMain.handle('all-debrid:update-key', async () => {
        const key = readAlldebridKey();
        if (!key)
            return false;
        allDebridClient = new AllDebrid({ apiKey: key });
        return true;
    });
    async function safeAllDebridCall(operation, errorMessage) {
        try {
            return await operation();
        }
        catch (err) {
            console.error(err);
            sendNotification({
                message: errorMessage,
                id: Math.random().toString(36).substring(7),
                type: 'error',
            });
            return null;
        }
    }
    ipcMain.handle('all-debrid:get-user-info', async () => {
        return safeAllDebridCall(() => allDebridClient.getUserInfo(), 'Failed to fetch AllDebrid user info');
    });
    ipcMain.handle('all-debrid:get-hosts', async () => {
        return safeAllDebridCall(() => allDebridClient.getHosts(), 'Failed to fetch AllDebrid hosts');
    });
    ipcMain.handle('all-debrid:add-magnet', async (_, arg) => {
        return safeAllDebridCall(() => allDebridClient.addMagnet(arg.url, arg.host), 'Failed to add magnet to AllDebrid');
    });
    ipcMain.handle('all-debrid:is-torrent-ready', async (_, id) => {
        return safeAllDebridCall(() => allDebridClient.isTorrentReady(id), 'Failed to check AllDebrid torrent status');
    });
    ipcMain.handle('all-debrid:get-torrent-info', async (_, id) => {
        return safeAllDebridCall(() => allDebridClient.getMagnetFiles(id), 'Failed to get AllDebrid torrent info');
    });
    ipcMain.handle('all-debrid:unrestrict-link', async (_, link) => {
        return safeAllDebridCall(() => allDebridClient.unrestrictLink(link), 'Failed to unrestrict AllDebrid link');
    });
    // AllDebrid auto-selects all files; no explicit selection needed
    ipcMain.handle('all-debrid:select-torrent', async () => {
        return true;
    });
    // Streams (fileStream, responseStream, readStream) are explicitly destroyed on all paths to avoid leaks.
    ipcMain.handle('all-debrid:add-torrent', async (_, arg) => {
        const tempPath = join(__dirname, `temp-alldebrid-${Date.now()}-${Math.random().toString(36).slice(2)}.torrent`);
        let fileStream = null;
        let responseStream = null;
        const controller = new AbortController();
        const MAX_BYTES = 10 * 1024 * 1024; // 10MB limit for torrent files
        try {
            fileStream = fs.createWriteStream(tempPath);
            const response = await axios({
                method: 'get',
                url: arg.torrent,
                responseType: 'stream',
                timeout: 30000, // Connection timeout
                signal: controller.signal,
            });
            responseStream = response.data;
            let bytesRead = 0;
            await new Promise((resolve, reject) => {
                const streamTimeout = setTimeout(() => {
                    controller.abort();
                    onError(new Error('Torrent download timed out after 60 seconds'));
                }, 60000);
                const onError = (err) => {
                    clearTimeout(streamTimeout);
                    cleanup();
                    reject(err);
                };
                const cleanup = () => {
                    if (fileStream) {
                        fileStream.destroy();
                        fileStream = null;
                    }
                    if (responseStream) {
                        responseStream.destroy();
                        responseStream = null;
                    }
                };
                if (responseStream && fileStream) {
                    responseStream.on('data', (chunk) => {
                        bytesRead += chunk.length;
                        if (bytesRead > MAX_BYTES) {
                            controller.abort();
                            onError(new Error(`Torrent file exceeds size limit of ${MAX_BYTES} bytes`));
                        }
                    });
                    responseStream.pipe(fileStream);
                    fileStream.on('finish', () => {
                        clearTimeout(streamTimeout);
                        resolve();
                    });
                    fileStream.on('error', onError);
                    responseStream.on('error', onError);
                }
                else {
                    clearTimeout(streamTimeout);
                    reject(new Error('Failed to initialize streams'));
                }
            });
            if (fileStream) {
                fileStream.close();
                fileStream = null;
            }
            if (responseStream) {
                responseStream.destroy();
                responseStream = null;
            }
            const readStream = fs.createReadStream(tempPath);
            try {
                const data = await allDebridClient.addTorrent(readStream);
                return data;
            }
            finally {
                readStream.destroy();
            }
        }
        catch (err) {
            if (fileStream) {
                fileStream.destroy();
                fileStream = null;
            }
            if (responseStream) {
                responseStream.destroy();
                responseStream = null;
            }
            console.error(err);
            sendNotification({
                message: 'Failed to add torrent to AllDebrid',
                id: Math.random().toString(36).substring(7),
                type: 'error',
            });
            return null;
        }
        finally {
            if (fileStream) {
                fileStream.destroy();
                fileStream = null;
            }
            if (responseStream) {
                responseStream.destroy();
                responseStream = null;
            }
            try {
                if (fs.existsSync(tempPath))
                    fs.unlinkSync(tempPath);
            }
            catch {
                // ignore
            }
        }
    });
}
//# sourceMappingURL=handler.alldebrid.js.map