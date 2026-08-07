# `@ogi-sdk/logger`

Shared Effect logging for OpenGameInstaller.

```ts
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';

const logger = createLogger(LOGGER_PREFIXES.electron);

// Effect-native logging
const task = Effect.gen(function* () {
  yield* logger.info('Starting task');
}).pipe(logger.observe);

// Imperative callbacks
logger.sync.error('Task failed', error);
```

Prefixes and the `makeLoggerPrefix` generator live in `src/prefixes.ts`. The logger renders messages as `[electron INFO] ...` and preserves structured arguments, annotations, and causes.
