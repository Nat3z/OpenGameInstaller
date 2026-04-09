import { spawn } from 'child_process';

const s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';

export async function extraction(filePath: string, outputDir: string) {
  if (process.platform === 'win32') {
    // expect 7zip to be installed, and use 7zip to unrar
    const process = spawn(s7ZipPath, ['x', filePath, '-o', outputDir]);
    return await new Promise<void>((resolve, reject) => {
      process.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('Failed to unrar file'));
        }
        resolve();
      });
    });
  } else if (process.platform === 'linux' || process.platform === 'darwin') {
    if (filePath.endsWith('.zip')) {
      // expect unzip to be installed, and use unzip to unzip
      const process = spawn('unzip', ['-o', filePath, '-d', outputDir]);
      return await new Promise<void>((resolve, reject) => {
        process.on('close', (code) => {
          if (code !== 0) {
            reject(new Error('Failed to unzip file'));
          }
          resolve();
        });
      });
    } else if (filePath.endsWith('.rar')) {
      // check if unrar-nonfree is installed or unrar is installed
      const unrar = spawn('unrar');

      // check the data output, and see if it contains 'unrar-free'
      let unrarType: 'unrar-free' | 'unrar-nonfree' | 'unknown' =
        await new Promise((resolve) => {
          unrar.stdout.on('data', (data) => {
            if (data.toString().includes('unrar-free')) {
              resolve('unrar-free');
            } else if (data.toString().includes('unrar-nonfree')) {
              resolve('unrar-nonfree');
            } else {
              resolve('unknown');
            }
          });
        });

      // now use the according unrar version to unrar
      if (unrarType === 'unrar-free') {
        // use unrar-free to unrar
        const process = spawn('unrar', ['-f', '-x', filePath, outputDir]);
        return await new Promise<void>((resolve, reject) => {
          process.on('close', (code) => {
            if (code !== 0) {
              reject(new Error('Failed to unrar file'));
            }
            resolve();
          });
        });
      } else if (unrarType === 'unrar-nonfree') {
        // use unrar-nonfree to unrar
        const process = spawn('unrar', ['-o', filePath, '-d', outputDir]);
        return await new Promise<void>((resolve, reject) => {
          process.on('close', (code) => {
            if (code !== 0) {
              reject(new Error('Failed to unrar file'));
            }
            resolve();
          });
        });
      } else {
        throw new Error('Unknown unrar type');
      }
    }
  }
}
