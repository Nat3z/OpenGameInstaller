# Download Services Architecture

This folder contains the new, class-based approach for handling the different
kinds of downloads supported by the client.

## Services

- `BaseService` – abstract contract every concrete service must implement.
- `RequestService` – resolves addon-initiated downloads by calling the addon backend.
- `TorrentService` – handles normal magnet/torrent downloads via the configured torrent client.
- `RealDebridService` – routes torrents through Real-Debrid for premium download speeds.
- `DirectService` – straightforward HTTP/DDL downloads (single or multi-part).

## Architecture

The `lifecycle.ts` file now uses a service discovery pattern:

1. It checks if any service in `ALL_SERVICES` handles the current `downloadType`
2. If found, it delegates to that service's `startDownload()` method
3. The old switch-case remains as a fallback for any unhandled types

This approach makes it easy to add new download types by simply creating a new service class that extends `BaseService`.

## Migration Status

✅ **COMPLETED**: All download types have been migrated to their respective service classes.
✅ **COMPLETED**: Service discovery is working in `lifecycle.ts`.
✅ **COMPLETED**: Old switch-case has been removed from `lifecycle.ts`.
✅ **COMPLETED**: Migration is fully complete!

The download system now uses a clean, extensible service-based architecture.
