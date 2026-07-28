import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findUnexpectedFixtureRequests,
  findUnexpectedOfflineTraffic,
} from '../src/packaged-handoff-audit';

describe('Packaged handoff audit', () => {
  test('rejects unexpected Fixture Service requests in every journey mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-fixture-audit-'));
    const requestLogPath = join(root, 'fixture-requests.jsonl');
    writeFileSync(
      requestLogPath,
      [
        { method: 'GET', path: '/release.json', unexpected: false },
        { method: 'GET', path: '/unknown', unexpected: true },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    );

    expect(findUnexpectedFixtureRequests(requestLogPath)).toEqual([
      expect.objectContaining({
        source: requestLogPath,
        path: '/unknown',
        unexpected: true,
      }),
    ]);
  });

  test('keeps Fixture Service auditing in offline transport checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-offline-audit-'));
    const trafficLogPath = join(root, 'traffic.jsonl');
    const requestLogPath = join(root, 'fixture-requests.jsonl');
    writeFileSync(trafficLogPath, `${JSON.stringify({ expected: true })}\n`);
    writeFileSync(
      requestLogPath,
      `${JSON.stringify({ path: '/unexpected', unexpected: true })}\n`
    );

    expect(
      findUnexpectedOfflineTraffic([trafficLogPath], requestLogPath)
    ).toEqual([
      expect.objectContaining({
        source: requestLogPath,
        path: '/unexpected',
        unexpected: true,
      }),
    ]);
  });
});
