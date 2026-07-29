import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';

describe('@ogi/errors package contract', () => {
  test('loads through Node without runtime TypeScript stripping', () => {
    const result = spawnSync(
      'node',
      ['--input-type=module', '--eval', "import('@ogi/errors')"],
      {
        cwd: import.meta.dir,
        encoding: 'utf8',
      }
    );

    expect(result.stderr).not.toContain(
      'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
