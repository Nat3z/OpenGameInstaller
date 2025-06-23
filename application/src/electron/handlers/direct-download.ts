import { ipcMain } from "electron";
import * as fs from "fs";
import { sendNotification, __dirname } from "../main.js";
import axios from "axios";


export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('ddl:download', async (_, args: { link: string, path: string }[]) => {
    const downloadID = Math.random().toString(36).substring(7);
    // arg is a link
    // download the link
    // get the name of the file
    new Promise<void>(async (resolve, reject) => {
      let parts = 0
      for (const arg of args) {
        parts++
        if (fs.existsSync(arg.path)) {
          sendNotification({
            message: 'File at path already exists. Please delete the file and try again.',
            id: downloadID,
            type: 'error'
          });
          if (mainWindow && mainWindow.webContents)
            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: 'File at path already exists. Please delete the file and try again.' });
          return reject();
        }
        // generate the path if it doesn't exist
        fs.mkdirSync(arg.path.split('/').slice(0, -1).join('/'), { recursive: true });
        let fileStream = fs.createWriteStream(arg.path);

        // get file size first
        console.log("Starting download...")

        fileStream.on('error', (err) => {
          console.error(err);
          if (mainWindow && mainWindow.webContents)
            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
          fileStream.close();
          reject()
        });
        console.log(arg.link)
        await new Promise<void>((resolve_dw, reject_dw) =>
          axios({
            method: 'get',
            url: arg.link,
            responseType: 'stream'
          }).then(response => {
            let fileSize = response.headers['content-length']!!;
            const startTime = Date.now();
            response.data.pipe(fileStream);
            response.data.on('data', () => {
              const progress = fileStream.bytesWritten / fileSize;
              const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
              const bytesRead = response.data?.socket?.bytesRead ?? fileStream.bytesWritten;
              const downloadSpeed = bytesRead / elapsedTime;
              if (mainWindow && mainWindow.webContents)
                mainWindow.webContents.send('ddl:download-progress', { id: downloadID, progress, downloadSpeed, fileSize, part: parts, totalParts: args.length });
              else
                response.data.destroy()
            });

            response.data.on('end', () => {
              console.log("Download complete for part " + parts)
              fileStream.close();
              resolve_dw();
            });

            response.data.on('error', () => {
              if (mainWindow && mainWindow.webContents)
                mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: '' });
              fileStream.close();
              fs.unlinkSync(arg.path);
              reject_dw();
            });
          }).catch(err => {
            console.error(err);
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
            fileStream.close();
            fs.unlinkSync(arg.path);
            sendNotification({
              message: 'Download failed for ' + arg.path,
              id: downloadID,
              type: 'error'
            });
            reject_dw();
          })
        );
      }
      if (mainWindow && mainWindow.webContents)
        mainWindow.webContents.send('ddl:download-complete', { id: downloadID });
      resolve();

    }).then(() => {
      console.log('Download complete!!');
    }).catch((err) => {
      console.log('Download failed');
      sendNotification({
        message: 'Direct Download Failed',
        id: downloadID,
        type: 'error'
      });
      console.error(err);
    });
    // stream the download 
    return downloadID;
  });

}
