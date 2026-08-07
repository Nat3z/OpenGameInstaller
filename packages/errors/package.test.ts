import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';

describe('@ogi-sdk/errors package contract', () => {
  test('loads ESM and CommonJS through Node without runtime TypeScript stripping', () => {
    const esmResult = spawnSync(
      'node',
      ['--input-type=module', '--eval', "import('@ogi-sdk/errors')"],
      {
        cwd: import.meta.dir,
        encoding: 'utf8',
      }
    );

    expect(esmResult.stderr).not.toContain(
      'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
    );
    expect(esmResult.status, esmResult.stderr).toBe(0);

    const cjsResult = spawnSync(
      'node',
      ['--eval', "require('@ogi-sdk/errors')"],
      {
        cwd: import.meta.dir,
        encoding: 'utf8',
      }
    );

    expect(cjsResult.stderr).not.toContain(
      'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
    );
    expect(cjsResult.status, cjsResult.stderr).toBe(0);
  });
});
