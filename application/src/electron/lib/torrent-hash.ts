import { formatError, TorrentError } from '@ogi/errors';
import { Effect } from 'effect';
import parseTorrent from 'parse-torrent';

export function getTorrentInfoHash(
  input: string | Buffer | Uint8Array
): Effect.Effect<string, TorrentError> {
  return Effect.tryPromise({
    try: async () => (await parseTorrent(input)).infoHash,
    catch: (cause) =>
      new TorrentError({
        message: `Failed to parse torrent: ${formatError(cause)}`,
        cause,
      }),
  });
}
