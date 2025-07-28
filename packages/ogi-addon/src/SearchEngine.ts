export type SearchResult = {
  name: string;
  downloadType: 'torrent' | 'direct' | 'magnet' | 'request';
  filename?: string;
  downloadURL?: string;
  files?: {
    name: string;
    downloadURL: string;
    headers?: Record<string, string>;
  }[];
  manifest?: Record<string, any>;
};
