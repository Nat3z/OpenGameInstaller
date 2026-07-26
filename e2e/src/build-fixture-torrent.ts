import { resolve } from 'node:path';

const result = await Bun.build({
  entrypoints: [
    resolve(
      import.meta.dir,
      '../../application/src/electron/handlers/handler.torrent.ts'
    ),
  ],
  target: 'node',
  format: 'esm',
  external: ['electron', 'original-fs'],
  outdir: resolve(import.meta.dir, '../fixture-addon/dist'),
  naming: 'torrent-runtime.mjs',
  plugins: [
    {
      name: 'disable-fixture-webrtc',
      setup(build) {
        build.onResolve({ filter: /^webrtc-polyfill$/ }, () => ({
          path: 'webrtc-disabled',
          namespace: 'ogi-e2e',
        }));
        build.onLoad(
          { filter: /^webrtc-disabled$/, namespace: 'ogi-e2e' },
          () => ({
            loader: 'js',
            contents: `
              export const RTCPeerConnection = undefined;
              export const RTCSessionDescription = undefined;
              export const RTCIceCandidate = undefined;
            `,
          })
        );
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
