import { describe, expect, test } from 'bun:test';
import { AddonError } from '@ogi/errors';
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

  test('maps a rejected deferred promise to AddonError', async () => {
    const event = new EventResponse<void>();
    event.defer(() => Promise.reject(new Error('deferred failure')));

    const deferred = await Effect.runPromise(event.awaitDeferredEffect());
    expect(deferred).toBeDefined();
    const result = await Effect.runPromise(deferred!.pipe(Effect.either));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(AddonError);
  });

  test('releases a waiting supervisor when the event resolves directly', async () => {
    const event = new EventResponse<string>();
    const deferredPromise = Effect.runPromise(event.awaitDeferredEffect());

    event.resolve('done');

    expect(await deferredPromise).toBeUndefined();
    expect(event.data).toBe('done');
  });

  test('releases a waiting supervisor when the event fails', async () => {
    const event = new EventResponse<string>();
    const deferredPromise = Effect.runPromise(event.awaitDeferredEffect());

    event.fail('failed');

    expect(await deferredPromise).toBeUndefined();
    expect(event.failed).toBe('failed');
  });
});
