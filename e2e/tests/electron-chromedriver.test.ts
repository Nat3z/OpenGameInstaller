import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareElectronChromedriver } from '../src/electron-chromedriver';

const generatedDirectories: string[] = [];
afterAll(() => {
  for (const directory of generatedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Electron Chromedriver', () => {
  test('downloads and extracts the driver matching the Electron release', async () => {
    const destinationDirectory = mkdtempSync(
      join(tmpdir(), 'ogi-electron-chromedriver-')
    );
    generatedDirectories.push(destinationDirectory);
    const requests: unknown[] = [];

    const executablePath = await prepareElectronChromedriver({
      destinationDirectory,
      electronVersion: '43.1.0',
      platform: 'darwin',
      arch: 'arm64',
      download: async (request) => {
        requests.push(request);
        return '/cache/chromedriver-v43.1.0-darwin-arm64.zip';
      },
      extract: async (_archivePath, options) => {
        writeFileSync(join(options.dir, 'chromedriver'), 'fixture driver');
      },
    });

    expect(requests).toEqual([
      {
        version: '43.1.0',
        artifactName: 'chromedriver',
        platform: 'darwin',
        arch: 'arm64',
      },
    ]);
    expect(executablePath).toBe(join(destinationDirectory, 'chromedriver'));
    expect(existsSync(executablePath)).toBe(true);
  });

  test('serializes concurrent preparation of the same driver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-electron-driver-race-'));
    generatedDirectories.push(root);
    const destinationDirectory = join(root, 'driver');
    let extractionCount = 0;
    const prepare = () =>
      prepareElectronChromedriver({
        destinationDirectory,
        electronVersion: '43.1.0',
        platform: 'darwin',
        arch: 'arm64',
        download: async () => '/cache/chromedriver.zip',
        extract: async (_archivePath, options) => {
          extractionCount++;
          await Bun.sleep(50);
          writeFileSync(join(options.dir, 'chromedriver'), 'fixture driver');
        },
      });

    const paths = await Promise.all([prepare(), prepare()]);

    expect(new Set(paths)).toEqual(
      new Set([join(destinationDirectory, 'chromedriver')])
    );
    expect(extractionCount).toBe(1);
  });
});
