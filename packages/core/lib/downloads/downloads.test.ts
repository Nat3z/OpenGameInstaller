import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { Downloads, DownloadsLive } from './downloads';

// The engine/pipeline split: engines report under their own id, the pipeline
// owns the card. These pin down what an engine may and may not change.

const run = <A>(f: (d: Downloads['Type']) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.flatMap(Downloads, f).pipe(Effect.provide(DownloadsLive))
  );

describe('Downloads', () => {
  test('alias keeps what the engine reported before it was linked', async () => {
    const card = await run((d) =>
      Effect.gen(function* () {
        yield* d.report('card', { status: 'resolving', name: 'Game' });
        yield* d.report('engine', { status: 'queued', queuePosition: 2 });
        yield* d.alias('engine', 'card');
        return yield* d.get('card');
      })
    );
    expect(card?.status).toBe('queued');
    expect(card?.queuePosition).toBe(2);
    expect(card?.name).toBe('Game');
  });

  test('a seeding engine cannot overwrite setup or bring back a cleared card', async () => {
    const [during, after] = await run((d) =>
      Effect.gen(function* () {
        yield* d.alias('engine', 'card');
        yield* d.report('card', { status: 'setting-up', progress: 0.3 });
        yield* d.report('engine', { status: 'seeding', progress: 1 });
        const during = yield* d.get('card');
        yield* d.clear('card');
        yield* d.report('engine', { status: 'seeding', progress: 1 });
        return [during, yield* d.get('card')] as const;
      })
    );
    expect(during?.status).toBe('setting-up');
    expect(during?.progress).toBe(0.3);
    expect(after).toBeUndefined();
  });

  test('setLogs publishes only new addon lines, after the pipeline’s own', async () => {
    const lines = await run((d) =>
      Effect.gen(function* () {
        yield* d.log('card', ['Extracting...', 'Extracted']);
        yield* d.setLogs('card', ['a', 'b', 'c']);
        yield* d.setLogs('card', ['a', 'b', 'c', 'd']);
        return yield* Effect.scoped(
          Effect.map(d.logs('card'), ({ snapshot }) => snapshot)
        );
      })
    );
    expect(lines).toEqual(['Extracting...', 'Extracted', 'a', 'b', 'c', 'd']);
  });

  test('a seeding engine still updates its ratio after setup', async () => {
    const card = await run((d) =>
      Effect.gen(function* () {
        yield* d.alias('engine', 'card');
        yield* d.report('card', { status: 'seeding', progress: 1 });
        yield* d.report('engine', {
          status: 'seeding',
          progress: 0.2,
          ratio: 1.5,
        });
        return yield* d.get('card');
      })
    );
    expect(card?.ratio).toBe(1.5);
    expect(card?.progress).toBe(1);
  });
});
