import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  normalizeBleedingEdgeSelection,
  selectAndBuildBleedingEdge,
} from '../src/bleeding-edge-flow.js';

test('uses the default branch for a whitespace-only selection', () => {
  expect(normalizeBleedingEdgeSelection('   ', ' abc123 ', 'main')).toEqual({
    branch: 'main',
    commit: 'abc123',
  });
});

test('persists a bleeding-edge selection before a build can fail', async () => {
  const events: string[] = [];
  const selection = { branch: 'feature/test', commit: 'abc123' };

  const exit = await Effect.runPromiseExit(
    selectAndBuildBleedingEdge(
      selection,
      (target) =>
        Effect.sync(() => {
          events.push(`persist:${target.branch}:${target.commit}`);
        }),
      () =>
        Effect.gen(function* () {
          events.push('build');
          return yield* Effect.fail('build failed');
        })
    )
  );

  expect(exit._tag).toBe('Failure');
  expect(events).toEqual(['persist:feature/test:abc123', 'build']);
});

test('normalizes fully qualified branch refs without stripping branch paths', () => {
  for (const branch of [
    'refs/heads/feature/test',
    'refs/remotes/origin/feature/test',
    'feature/test',
  ]) {
    expect(normalizeBleedingEdgeSelection(branch, '', 'main').branch).toBe(
      'feature/test'
    );
  }
});
