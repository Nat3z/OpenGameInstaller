export type SearchResult = {
  name: string;
  downloadType: 'torrent' | 'direct' | 'magnet' | 'request';
  storefront: 'steam' | 'internal';
  filename?: string;
  downloadURL?: string;
  files?: {
    name: string;
    downloadURL: string;
  }[];
};
