import { Data } from 'effect';

// =============================================================================
// Download Errors
// =============================================================================

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

// =============================================================================
// Network Errors
// =============================================================================

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

// =============================================================================
// File System Errors
// =============================================================================

export class FileSystemError extends Data.TaggedClass('FileSystemError')<{
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Addon Errors
// =============================================================================

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

// =============================================================================
// Config Errors
// =============================================================================

export class ConfigError extends Data.TaggedClass('ConfigError')<{
  readonly message: string;
  readonly key?: string;
}> {}

// =============================================================================
// Debrid Service Errors
// =============================================================================

export class DebridError extends Data.TaggedClass('DebridError')<{
  readonly message: string;
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
  readonly apiCode?: string;
}> {}

export class DebridAuthError extends Data.TaggedClass('DebridAuthError')<{
  readonly service: 'alldebrid' | 'realdebrid' | 'premiumize' | 'torbox';
}> {}

// =============================================================================
// Library Errors
// =============================================================================

export class LibraryError extends Data.TaggedClass('LibraryError')<{
  readonly message: string;
  readonly gameId?: number;
}> {}

export class GameNotFound extends Data.TaggedClass('GameNotFound')<{
  readonly gameId: number;
}> {}

// =============================================================================
// Torrent Errors
// =============================================================================

export class TorrentError extends Data.TaggedClass('TorrentError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// =============================================================================
// Validation Errors
// =============================================================================

export class ValidationError extends Data.TaggedClass('ValidationError')<{
  readonly message: string;
  readonly field?: string;
}> {}

// =============================================================================
// Platform Errors
// =============================================================================

export class PlatformError extends Data.TaggedClass('PlatformError')<{
  readonly message: string;
  readonly platform?: string;
}> {}

// =============================================================================
// Updater Errors
// =============================================================================

export class UpdateError extends Data.TaggedClass('UpdateError')<{
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
