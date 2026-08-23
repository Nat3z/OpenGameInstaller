import { describe, expect, test } from 'bun:test';
import EventResponse from './EventResponse';

describe('EventResponse deferred work', () => {
  test('provides deferred work registered before supervision starts', async () => {
    const event = new EventResponse<void>();
    event.defer(() => event.complete());

    const work = await event.nextDeferred();
    expect(work).toBeDefined();
    await work!();
    expect(event.resolved).toBe(true);
  });

  test('waits for deferred work registered asynchronously', async () => {
    const event = new EventResponse<string>();
    const workPromise = event.nextDeferred();

    await Promise.resolve();
    event.defer(() => event.resolve('done'));

    const work = await workPromise;
    expect(work).toBeDefined();
    await work!();
    expect(event.data).toBe('done');
  });

  test('surfaces a rejected deferred promise to the supervisor', async () => {
    const event = new EventResponse<void>();
    event.defer(() => Promise.reject(new Error('deferred failure')));

    const work = await event.nextDeferred();
    expect(work).toBeDefined();
    await expect(work!()).rejects.toThrow('deferred failure');
    expect(event.resolved).toBe(false);
  });

  test('releases a waiting supervisor when the event resolves directly', async () => {
    const event = new EventResponse<string>();
    const workPromise = event.nextDeferred();

    event.resolve('done');

    expect(await workPromise).toBeUndefined();
    expect(event.data).toBe('done');
  });

  test('releases a waiting supervisor when the event fails', async () => {
    const event = new EventResponse<string>();
    const workPromise = event.nextDeferred();

    event.fail('failed');

    expect(await workPromise).toBeUndefined();
    expect(event.failed).toBe('failed');
  });
});
