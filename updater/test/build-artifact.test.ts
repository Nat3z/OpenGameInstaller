import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installBleedingEdgeArtifact } from '../src/build-artifact.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): { root: string; destination: string; dist: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-artifact-'));
  roots.push(root);
  const destination = path.join(root, 'update');
  const dist = path.join(root, 'application', 'dist');
  fs.mkdirSync(destination);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(destination, 'old-build'), 'working build');
  fs.writeFileSync(path.join(destination, 'latest.log'), 'keep log');
  return { root, destination, dist };
}

test('installs the complete Windows directory including resources and DLLs', () => {
  const { root, destination, dist } = fixture();
  const unpacked = path.join(dist, 'win-unpacked');
  fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'OpenGameInstaller.exe'), 'exe');
  fs.writeFileSync(path.join(unpacked, 'resources', 'app.asar'), 'app');
  fs.writeFileSync(path.join(unpacked, 'ffmpeg.dll'), 'dll');
  installBleedingEdgeArtifact(
    root,
    destination,
    'win32',
    new Set(['latest.log'])
  );
  expect(
    fs.readFileSync(path.join(destination, 'resources', 'app.asar'), 'utf8')
  ).toBe('app');
  expect(fs.readFileSync(path.join(destination, 'ffmpeg.dll'), 'utf8')).toBe(
    'dll'
  );
  expect(fs.readFileSync(path.join(destination, 'latest.log'), 'utf8')).toBe(
    'keep log'
  );
  expect(fs.existsSync(path.join(destination, 'old-build'))).toBe(false);
});

test('keeps the working installation when the build output is missing', () => {
  const { root, destination } = fixture();
  expect(() =>
    installBleedingEdgeArtifact(root, destination, 'linux', new Set())
  ).toThrow();
  expect(fs.readFileSync(path.join(destination, 'old-build'), 'utf8')).toBe(
    'working build'
  );
});

test('installs only the expected Linux artifact and makes it executable', () => {
  const { root, destination, dist } = fixture();
  fs.writeFileSync(path.join(dist, 'stale.AppImage'), 'stale');
  fs.writeFileSync(
    path.join(dist, 'OpenGameInstaller-linux-pt.AppImage'),
    'new'
  );
  installBleedingEdgeArtifact(
    root,
    destination,
    'linux',
    new Set(['latest.log'])
  );
  const appImage = path.join(destination, 'OpenGameInstaller.AppImage');
  expect(fs.readFileSync(appImage, 'utf8')).toBe('new');
  if (process.platform !== 'win32')
    expect(fs.statSync(appImage).mode & 0o777).toBe(0o755);
});
