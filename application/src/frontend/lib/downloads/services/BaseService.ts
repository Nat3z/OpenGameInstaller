import type { SearchResultWithAddon } from '../../tasks/runner';

/**
 * Base class that all concrete download services should extend. It defines a
 * minimal contract so each service can be discovered and invoked in a generic
 * fashion.
 */
export abstract class BaseService {
  /**
   * List of downloadType strings handled by this service (e.g. ['torrent', 'magnet']).
   */
  abstract readonly types: string[];

  /**
   * Execute the download flow for the given result. Concrete implementations
   * should move the logic that currently lives in lifecycle.ts into this
   * method.
   */
  abstract startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void>;
}
