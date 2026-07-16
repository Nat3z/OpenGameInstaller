import { Data } from 'effect';

export { runEffectBoundary, runSyncBoundary } from './boundary.js';

// =============================================================================
// Download Errors
// =============================================================================

export class DownloadError extends Data.TaggedError('DownloadError')<{
  readonly message: string;
  readonly downloadId?: string;
  readonly cause?: unknown;
}> {}

export class DownloadNotActive extends Data.TaggedError('DownloadNotActive')<{
  readonly downloadId: string;
}> {}

export class TooManyRequests extends Data.TaggedError('TooManyRequests')<{
  readonly retryAfter?: number;
}> {}

export class ConnectionRefreshRequested extends Data.TaggedError('ConnectionRefreshRequested')<{
  readonly downloadId: string;
}> {}

// =============================================================================
// Network Errors
// =============================================================================

export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly message: string;
  readonly statusCode?: number;
  readonly url?: string;
}> {}

export class HttpError extends Data.TaggedError('HttpError')<{
  readonly statusCode: number;
  readonly message: string;
  readonly url?: string;
}> {}

// =============================================================================
// File System Errors
// =============================================================================

export class FileSystemError extends Data.TaggedError('FileSystemError')<{
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Addon Errors
// =============================================================================

export class AddonError extends Data.TaggedError('AddonError')<{
  readonly message: string;
  readonly addonName?: string;
}> {}

export class AddonNotFound extends Data.TaggedError('AddonNotFound')<{
  readonly addonName: string;
}> {}

export class AddonLoadError extends Data.TaggedError('AddonLoadError')<{
  readonly addonName: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Config Errors
// =============================================================================

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string;
  readonly key?: string;
}> {}

// =============================================================================
// Debrid Service Errors
// =============================================================================

export class DebridError extends Data.TaggedError('DebridError')<{
  readonly message: string;
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
  readonly apiCode?: string;
}> {}

export class DebridAuthError extends Data.TaggedError('DebridAuthError')<{
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
}> {}

// =============================================================================
// Library Errors
// =============================================================================

export class LibraryError extends Data.TaggedError('LibraryError')<{
  readonly message: string;
  readonly gameId?: number;
}> {}

export class GameNotFound extends Data.TaggedError('GameNotFound')<{
  readonly gameId: number;
}> {}

// =============================================================================
// Torrent Errors
// =============================================================================

export class TorrentError extends Data.TaggedError('TorrentError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Validation Errors
// =============================================================================

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string;
  readonly field?: string;
}> {}

// =============================================================================
// Platform Errors
// =============================================================================

export class PlatformError extends Data.TaggedError('PlatformError')<{
  readonly message: string;
  readonly platform?: string;
}> {}

// =============================================================================
// Updater Errors
// =============================================================================

export class UpdateError extends Data.TaggedError('UpdateError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Union type for all OGI errors
// =============================================================================

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

// =============================================================================
// Error formatting helper
// =============================================================================

export const formatError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as { _tag: string; message?: string };
    return tagged.message ?? tagged._tag;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

export const formatErrorResponse = (error: unknown): { status: 'error'; error: string } => ({
  status: 'error',
  error: formatError(error),
});
