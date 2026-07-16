# Effect-TS Migration Guide for OpenGameInstaller

## Overview

Convert the entire OGI codebase to Effect-TS with composed tagged errors, 
dependency injection via Layers, and Effect.Schema replacing Zod.

## CRITICAL RULES

1. `await` does NOT unwrap Effects. Use `yield*` inside `Effect.gen`.
2. `Data.TaggedClass` instances are NOT `instanceof Error`. Never wrap them in `new Error()`.
3. All Effects must be run at boundaries via `Effect.runPromise` or `Effect.runSync`.
4. Never mix `await` and `yield*` for Effect-returning functions in the same scope.

## Step 1: Shared Error Package (`packages/errors/`)

Create `@ogi/errors` with all tagged error classes:

```typescript
// packages/errors/src/index.ts
import { Data } from 'effect';

// --- Download Errors ---
export class DownloadError extends Data.TaggedClass('DownloadError')<{
  readonly message: string;
  readonly downloadId?: string;
  readonly cause?: unknown;
}> {}

export class DownloadNotActive extends Data.TaggedClass('DownloadNotActive')<{
  readonly downloadId: string;
}> {}

export class TooManyRequests extends Data.TaggedClass('TooManyRequests')<{
  readonly retryAfter?: number;
}> {}

export class ConnectionRefreshRequested extends Data.TaggedClass('ConnectionRefreshRequested')<{
  readonly downloadId: string;
}> {}

// --- Network Errors ---
export class NetworkError extends Data.TaggedClass('NetworkError')<{
  readonly message: string;
  readonly statusCode?: number;
  readonly url?: string;
}> {}

export class HttpError extends Data.TaggedClass('HttpError')<{
  readonly statusCode: number;
  readonly message: string;
  readonly url?: string;
}> {}

// --- File System Errors ---
export class FileSystemError extends Data.TaggedClass('FileSystemError')<{
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

// --- Addon Errors ---
export class AddonError extends Data.TaggedClass('AddonError')<{
  readonly message: string;
  readonly addonName?: string;
}> {}

export class AddonNotFound extends Data.TaggedClass('AddonNotFound')<{
  readonly addonName: string;
}> {}

export class AddonLoadError extends Data.TaggedClass('AddonLoadError')<{
  readonly addonName: string;
  readonly cause?: unknown;
}> {}

// --- Config Errors ---
export class ConfigError extends Data.TaggedClass('ConfigError')<{
  readonly message: string;
  readonly key?: string;
}> {}

// --- Debrid Service Errors ---
export class DebridError extends Data.TaggedClass('DebridError')<{
  readonly message: string;
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
  readonly apiCode?: string;
}> {}

export class DebridAuthError extends Data.TaggedClass('DebridAuthError')<{
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
}> {}

// --- Library Errors ---
export class LibraryError extends Data.TaggedClass('LibraryError')<{
  readonly message: string;
  readonly gameId?: number;
}> {}

export class GameNotFound extends Data.TaggedClass('GameNotFound')<{
  readonly gameId: number;
}> {}

// --- Torrent Errors ---
export class TorrentError extends Data.TaggedClass('TorrentError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// --- Validation Errors ---
export class ValidationError extends Data.TaggedClass('ValidationError')<{
  readonly message: string;
  readonly field?: string;
}> {}

// --- Platform Errors ---
export class PlatformError extends Data.TaggedClass('PlatformError')<{
  readonly message: string;
  readonly platform?: string;
}> {}

// --- Updater Errors ---
export class UpdateError extends Data.TaggedClass('UpdateError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Union type for all OGI errors
export type OgiError =
  | DownloadError
  | DownloadNotActive
  | TooManyRequests
  | ConnectionRefreshRequested
  | NetworkError
  | HttpError
  | FileSystemError
  | AddonError
  | AddonNotFound
  | AddonLoadError
  | ConfigError
  | DebridError
  | DebridAuthError
  | LibraryError
  | GameNotFound
  | TorrentError
  | ValidationError
  | PlatformError
  | UpdateError;
```

## Step 2: Effect Layers for Dependencies

Each major subsystem becomes a Layer:

```typescript
// packages/errors/src/layers/axios.ts
import { Context, Effect } from 'effect';
import axios, { type AxiosRequestConfig } from 'axios';

export class HttpClient extends Context.Tag('HttpClient')<
  HttpClient,
  {
    readonly get: <T>(url: string, config?: AxiosRequestConfig) => Effect.Effect<T, HttpError>;
    readonly post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => Effect.Effect<T, HttpError>;
    readonly head: <T>(url: string, config?: AxiosRequestConfig) => Effect.Effect<T, HttpError>;
  }
>() {}

export const HttpClientLive = HttpClient.of({
  get: (url, config) =>
    Effect.tryPromise({
      try: () => axios.get(url, config).then(r => r.data as any),
      catch: (e) => new HttpError({
        statusCode: (e as any)?.response?.status ?? 0,
        message: (e as any)?.message ?? 'Request failed',
        url,
      }),
    }),
  post: (url, data, config) =>
    Effect.tryPromise({
      try: () => axios.post(url, data, config).then(r => r.data as any),
      catch: (e) => new HttpError({
        statusCode: (e as any)?.response?.status ?? 0,
        message: (e as any)?.message ?? 'Request failed',
        url,
      }),
    }),
  head: (url, config) =>
    Effect.tryPromise({
      try: () => axios.head(url, config).then(r => r.data as any),
      catch: (e) => new HttpError({
        statusCode: (e as any)?.response?.status ?? 0,
        message: (e as any)?.message ?? 'Request failed',
        url,
      }),
    }),
});
```

## Step 3: Schema Migration (Zod -> Effect.Schema)

Convert Zod schemas to Effect.Schema:

```typescript
// BEFORE (zod):
import z from 'zod';
const UserInfoZod = z.object({
  username: z.string(),
  email: z.string(),
  isPremium: z.boolean(),
});
export type UserInfo = z.infer<typeof UserInfoZod>;

// AFTER (Effect.Schema):
import { Schema } from 'effect';

class UserInfo extends Schema.Class<UserInfo>('UserInfo')({
  username: Schema.String,
  email: Schema.String,
  isPremium: Schema.Boolean,
}) {}

// For API response wrapping:
const ApiResponseSuccess = <T>(dataSchema: Schema.Schema<T>) =>
  Schema.Struct({
    status: Schema.Literal('success'),
    data: dataSchema,
  });
```

## Step 4: Converting Functions

```typescript
// BEFORE:
export async function getFileInfo(id: string): Promise<FileInfo> {
  try {
    const response = await axios.get(`/api/files/${id}`);
    return FileInfoZod.parse(response.data);
  } catch (e) {
    throw new Error(`Failed to get file: ${e}`);
  }
}

// AFTER:
export const getFileInfo = (id: string): Effect.Effect<FileInfo, HttpError | ValidationError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient;
    const response = yield* client.get<unknown>(`/api/files/${id}`);
    return yield* Schema.decodeUnknown(FileInfoSchema)(response);
  });
```

## Step 5: IPC Handler Conversion (Electron)

```typescript
// BEFORE:
ipcMain.handle('ddl:download', async (_, args, part) => {
  try {
    const download = new Download(mainWindow, args, part);
    download.start();
    return await download.waitForReady();
  } catch (error) {
    return { status: 'error', error: String(error) };
  }
});

// AFTER:
const handleDownload = (mainWindow: BrowserWindow) =>
  Effect.gen(function* () {
    const download = yield* DownloadService.make(mainWindow);
    yield* download.start(args, part);
    return yield* download.waitForReady();
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({ status: 'error' as const, error: formatError(error) })
    )
  );

ipcMain.handle('ddl:download', (_, args, part) =>
  Effect.runPromise(handleDownload(mainWindow)(args, part))
);
```

## Step 6: Converting the Download Engine (handler.ddl.ts)

The Download class should be decomposed into Effect services:

1. DownloadService - manages download lifecycle via Effect Fibers
2. ConnectionHealthMonitor - Effect-based health monitoring 
3. ParallelDownloadService - chunk management via Effect
4. ProgressReporter - IPC progress via Effect streams

```typescript
// Download as Effect Fiber instead of class methods:
export const runDownload = (job: DownloadJob): Effect.Effect<void, DownloadError | NetworkError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient;
    const fs = yield* FileSystem;
    
    const response = yield* client.get<Readable>(job.link, {
      responseType: 'stream',
      headers: { Range: `bytes=${job.startByte}-` },
    });
    
    yield* pipeToFs(response, job.path);
  }).pipe(
    Effect.retry({ while: (e) => e._tag === 'ConnectionRefreshRequested' }),
    Effect.scoped
  );
```

## Step 7: Converting Frontend Services

```typescript
// BEFORE (BaseService subclass pattern):
export class AllDebridService extends BaseService {
  async startDownload(result, appID, event) { ... }
}

// AFTER (Effect service):
export class AllDebridDownloadService extends Context.Tag('AllDebridDownloadService')<
  AllDebridDownloadService,
  {
    readonly startDownload: (result: SearchResultWithAddon, appID: number) => Effect.Effect<void, DebridError | DownloadError>;
  }
>() {}
```

## Conversion Order

Execute in this exact order:

1. `packages/errors/` - Create the shared error package
2. `packages/all-debrid/` - Zod->Schema, wrap API calls
3. `packages/real-debrid/` - Same pattern
4. `packages/connection/` - WebSocket protocol to Effect streams  
5. `packages/client-kit/` - Connection layer
6. `packages/executor/` - Addon execution
7. `packages/addon-server/` - Server connection handling
8. `packages/ogi-addon/` - Addon SDK
9. `application/src/electron/handlers/handler.app.ts` - Small handler
10. `application/src/electron/handlers/handler.oobe.ts` - Setup wizard
11. `application/src/electron/handlers/handler.fs.ts` - File operations
12. `application/src/electron/handlers/handler.library.ts` - Library mgmt
13. `application/src/electron/handlers/handler.steam.ts` - Steam integration
14. `application/src/electron/handlers/handler.addon.ts` - Addon lifecycle
15. `application/src/electron/handlers/handler.alldebrid.ts` - AllDebrid handler
16. `application/src/electron/handlers/handler.realdebrid.ts` - RealDebrid handler
17. `application/src/electron/handlers/handler.torrent.ts` - Torrent handler
18. `application/src/electron/handlers/handler.redists.ts` - Redistributables
19. `application/src/electron/handlers/handler.power-save.ts` - Power save
20. `application/src/electron/handlers/handler.umu.ts` - UMU/Proton
21. `application/src/electron/handlers/handler.ddl.ts` - Download engine (BIGGEST)
22. `application/src/electron/lib/` - Shared utilities
23. `application/src/electron/manager/` - State managers
24. `application/src/electron/server/` - Addon server
25. `application/src/electron/startup.ts` - App initialization
26. `application/src/electron/main.ts` - Entry point boundaries
27. `application/src/frontend/lib/` - Frontend utilities
28. `application/src/frontend/lib/downloads/` - Download services
29. `updater/src/main.ts` - Updater

## Boundary Pattern

At every IPC/boundary point:

```typescript
// The ipcMain.handle boundary:
ipcMain.handle('channel', (_, ...args) =>
  Effect.runPromise(
    handlerLogic(...args).pipe(
      Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
    )
  )
);
```

## Error Formatting at Boundaries

```typescript
export const formatError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as { _tag: string; message?: string };
    return tagged.message ?? tagged._tag;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};
```

## After Each Package Conversion

Run `bun run typecheck` from the package directory to verify no type errors.
Commit with message: `refactor(effect): convert <package-name> to Effect-TS`
