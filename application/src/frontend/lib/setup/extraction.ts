export async function drillDownSingleDirectories(
  startDir: string,
  maxDepth: number = 10
): Promise<string> {
  try {
    let currentDir = startDir;
    let filesInDir: string[] =
      await window.electronAPI.fs.getFilesInDir(currentDir);
    if (filesInDir.length === 1) {
      let depth = 0;
      while (filesInDir.length === 1 && depth < maxDepth) {
        const nextPath = currentDir + '/' + filesInDir[0];
        let stat: { isDirectory: boolean } | undefined;
        try {
          stat = window.electronAPI.fs.stat(nextPath);
        } catch (e) {
          console.error('Failed to stat path:', nextPath, e);
          break;
        }
        if (!stat || !stat.isDirectory) break;
        currentDir = nextPath;
        filesInDir = await window.electronAPI.fs.getFilesInDir(currentDir);
        depth++;
      }
    }
    return currentDir;
  } catch (e) {
    console.error('Failed to traverse directories from:', startDir, e);
    return startDir;
  }
}

export async function unrarAndReturnOutputDir(params: {
  rarFilePath: string;
  outputBaseDir: string;
  downloadId: string;
}): Promise<string> {
  const { rarFilePath, outputBaseDir, downloadId } = params;
  console.log('Extracting RAR file:', rarFilePath, 'to', outputBaseDir);
  const extractedDir: string = await window.electronAPI.fs.unrar({
    outputDir: outputBaseDir,
    rarFilePath,
    downloadId,
  });
  try {
    if (rarFilePath) {
      window.electronAPI.fs.delete(rarFilePath);
      console.log('RAR file deleted:', rarFilePath);
    }
  } catch (error) {
    console.error('Failed to delete RAR file:', rarFilePath, error);
  }
  return extractedDir;
}

export async function unzipAndReturnOutputDir(params: {
  zipFilePath: string;
  outputDirBase: string;
  downloadId: string;
}): Promise<string | undefined> {
  const { zipFilePath, outputDirBase, downloadId } = params;
  console.log('Extracting ZIP file:', zipFilePath);
  let queriedOutput: string | null = await window.electronAPI.fs.unzip({
    zipFilePath,
    outputDir: outputDirBase,
    downloadId,
  });
  if (!queriedOutput) {
    return undefined;
  }
  let outputDir = queriedOutput;
  console.log('ZIP file extracted successfully');
  outputDir = await drillDownSingleDirectories(outputDir, 10);
  outputDir = outputDir + '/';
  try {
    window.electronAPI.fs.delete(zipFilePath);
    console.log('ZIP file deleted:', zipFilePath);
  } catch (error) {
    console.error('Failed to delete ZIP file:', zipFilePath, error);
  }
  return outputDir;
}
