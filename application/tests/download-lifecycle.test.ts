import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { resetButtonOnExit } from '../src/frontend/lib/downloads/button-state.js';

describe('download lifecycle', () => {
  test('runs button cleanup when a download service defects', async () => {
    let reset = false;

    await Effect.runPromiseExit(
      resetButtonOnExit(Effect.die(new Error('schema decode failed')), () => {
        reset = true;
      })
    );

    expect(reset).toBe(true);
  });
});
