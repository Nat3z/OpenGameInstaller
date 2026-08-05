import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { ElectronRpc } from '../src/lib/electron-rpc.js';

describe('Electron RPC payload schemas', () => {
  test('accept explicit undefined for optional positional arguments', () => {
    const payloads = [
      [ElectronRpc.app.addToSteam.payloadSchema, [1, undefined]],
      [
        ElectronRpc.app.updateAppVersion.payloadSchema,
        [
          1,
          '1.0.0',
          '/tmp/game',
          'game.exe',
          undefined,
          'addon-source',
          { umuId: 'umu:1' },
          undefined,
        ],
      ],
      [
        ElectronRpc.realdebrid.addMagnet.payloadSchema,
        ['magnet:?xt=urn:btih:test', undefined],
      ],
      [ElectronRpc.ddl.download.payloadSchema, [[], undefined]],
    ] as const;

    for (const [schema, payload] of payloads) {
      expect(() => Schema.decodeUnknownSync(schema)(payload)).not.toThrow();
    }
  });
});
