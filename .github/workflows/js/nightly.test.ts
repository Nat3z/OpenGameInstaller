import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { changedPackages, nightlyVersion, validateBlockmap } from './nightly';

test('promotion rejects malformed or incomplete blockmaps', () => {
  const blockmap = gzipSync(
    JSON.stringify({
      files: [{ offset: 0, sizes: [100, 50], checksums: ['a', 'b'] }],
    })
  );
  expect(() => validateBlockmap(150, blockmap)).not.toThrow();
  expect(() => validateBlockmap(151, blockmap)).toThrow();
  expect(() => validateBlockmap(150, Buffer.from('invalid'))).toThrow();
});

test('CI version identity is stable on retry and sorts within the next patch', () => {
  expect(nightlyVersion('4.3.1', '100')).toBe('4.3.2-nightly.100');
  expect(nightlyVersion('5.2.0', '100')).toBe('5.2.1-nightly.100');
  expect(() => nightlyVersion('4.3.1', 'bad')).toThrow();
});

test('dependency changes propagate through SDK consumers, not unrelated packages', () => {
  const manifests = new Map([
    ['packages/errors', { name: 'errors', version: '1.0.0' }],
    [
      'packages/connect',
      { name: 'connect', version: '1.0.0', dependencies: { errors: '^1.0.0' } },
    ],
    [
      'packages/addon',
      { name: 'addon', version: '1.0.0', dependencies: { connect: '^1.0.0' } },
    ],
    ['packages/other', { name: 'other', version: '1.0.0' }],
  ]);
  expect([
    ...changedPackages(['packages/errors/src/index.ts'], manifests),
  ]).toEqual(['errors', 'connect', 'addon']);
  expect(changedPackages(['docs/nightly.md'], manifests).size).toBe(0);
  expect(changedPackages(['bun.lock'], manifests).size).toBe(4);
});
