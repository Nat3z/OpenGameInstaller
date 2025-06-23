export declare function addTorrent(
  torrent: string | Uint8Array,
  path: string,
  onProgress: (
    downloadTotal: number,
    speed: number,
    progress: number,
    length: number
  ) => void,
  onDone: () => void
): Promise<void>;
export declare function seedTorrent(buffer: Buffer): Promise<void>;
export declare function stopClient(): Promise<void>;
