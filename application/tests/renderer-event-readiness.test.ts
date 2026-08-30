import { expect, test } from 'bun:test';
import { RendererEventReadiness } from '../src/electron/lib/renderer-event-readiness';

test('renderer readiness cancels its timeout after the renderer responds', async () => {
  const readiness = new RendererEventReadiness();
  let timeoutCalls = 0;
  const waiting = readiness.wait(10, () => timeoutCalls++);

  readiness.markReady();
  await waiting;
  await Bun.sleep(20);

  expect(timeoutCalls).toBe(0);
  expect(readiness.isReady()).toBe(true);
});

test('renderer readiness reports a genuine timeout', async () => {
  const readiness = new RendererEventReadiness();
  let timeoutCalls = 0;

  await readiness.wait(5, () => timeoutCalls++);

  expect(timeoutCalls).toBe(1);
  expect(readiness.isReady()).toBe(false);
});

test('renderer readiness resets for a new document', () => {
  const readiness = new RendererEventReadiness();
  readiness.markReady();
  readiness.reset();

  expect(readiness.isReady()).toBe(false);
});
