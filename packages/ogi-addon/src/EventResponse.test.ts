import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import EventResponse from './EventResponse';

describe('EventResponse deferred effects', () => {
  test('provides deferred work registered before supervision starts', async () => {
    const event = new EventResponse<void>();
    event.defer(() => Effect.sync(() => event.complete()));

    const deferred = await Effect.runPromise(event.awaitDeferredEffect());
    expect(deferred).toBeDefined();
    await Effect.runPromise(deferred!);
    expect(event.resolved).toBe(true);
  });

  test('waits for deferred work registered asynchronously', async () => {
    const event = new EventResponse<string>();
    const deferredPromise = Effect.runPromise(event.awaitDeferredEffect());

    await Promise.resolve();
    event.defer(() => Effect.sync(() => event.resolve('done')));

    const deferred = await deferredPromise;
    expect(deferred).toBeDefined();
    await Effect.runPromise(deferred!);
    expect(event.data).toBe('done');
  });

  test('releases a waiting supervisor when the event resolves directly', async () => {
    const event = new EventResponse<string>();
    const deferredPromise = Effect.runPromise(event.awaitDeferredEffect());

    event.resolve('done');

    expect(await deferredPromise).toBeUndefined();
    expect(event.data).toBe('done');
  });
});
