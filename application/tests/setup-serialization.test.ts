import { describe, expect, test } from 'bun:test';
import { toSerializable } from '../src/frontend/lib/setup/serialize.js';

describe('setup payload serialization', () => {
  test('copies proxy-backed addon data into a plain RPC value', () => {
    const manifest = new Proxy(
      { service: '1337x', nested: { source: 'Fatboy Unpack' } },
      {}
    );

    const serialized = toSerializable(manifest);

    expect(serialized).toEqual({
      service: '1337x',
      nested: { source: 'Fatboy Unpack' },
    });
    expect(serialized).not.toBe(manifest);
  });
});
