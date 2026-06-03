import { spawn } from 'child_process';

const s7ZipPath = 'C:\\Program Files\\7-Zip\\7z.exe';

function waitForChildProcess(
  childProcess: ReturnType<typeof spawn>,
  errorMessage: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorMessage));
        return;
      }

      resolve();
    });
  });
}

async function detectUnrarType(): Promise<
  'unrar-free' | 'unrar-nonfree' | 'unknown'
> {
  const childProcess = spawn('unrar');

  return await new Promise((resolve, reject) => {
    let output = '';

    const collectOutput = (data: Buffer) => {
      output += data.toString();
    };

    childProcess.stdout.on('data', collectOutput);
    childProcess.stderr.on('data', collectOutput);
    childProcess.once('error', reject);
    childProcess.once('close', () => {
      if (output.includes('unrar-free')) {
        resolve('unrar-free');
        return;
      }

      if (output.includes('unrar-nonfree')) {
        resolve('unrar-nonfree');
        return;
      }

      resolve('unknown');
    });
  });
}

export async function extraction(filePath: string, outputDir: string) {
  const lowerCaseFilePath = filePath.toLowerCase();

  if (process.platform === 'win32') {
    // expect 7zip to be installed, and use 7zip to unrar
    const childProcess = spawn(s7ZipPath, ['x', filePath, '-o', outputDir]);
    return await waitForChildProcess(childProcess, 'Failed to extract file');
  } else if (process.platform === 'linux' || process.platform === 'darwin') {
    if (lowerCaseFilePath.endsWith('.zip')) {
      // expect unzip to be installed, and use unzip to unzip
      const childProcess = spawn('unzip', ['-o', filePath, '-d', outputDir], {
        env: {
          ...process.env,
          UNZIP_DISABLE_ZIPBOMB_DETECTION: 'TRUE',
        },
      });
      return await waitForChildProcess(childProcess, 'Failed to unzip file');
    } else if (lowerCaseFilePath.endsWith('.rar')) {
      // check if unrar-nonfree is installed or unrar is installed
      const unrarType = await detectUnrarType();

      // now use the according unrar version to unrar
      if (unrarType === 'unrar-free') {
        // use unrar-free to unrar
        const childProcess = spawn('unrar', ['-f', '-x', filePath, outputDir]);
        return await waitForChildProcess(childProcess, 'Failed to unrar file');
      } else if (unrarType === 'unrar-nonfree') {
        // use unrar-nonfree to unrar
        const childProcess = spawn('unrar', ['-o', filePath, '-d', outputDir]);
        return await waitForChildProcess(childProcess, 'Failed to unrar file');
      } else {
        throw new Error('Unknown unrar type');
      }
    }

    throw new Error(`Unsupported archive type: ${filePath}`);
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}
