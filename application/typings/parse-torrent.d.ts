declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string;
    name?: string;
    announce?: string | string[];
    urlList?: string[];
  }

  export default function parseTorrent(
    torrentId: string | Buffer | Uint8Array | ParsedTorrent
  ): Promise<ParsedTorrent>;
}
