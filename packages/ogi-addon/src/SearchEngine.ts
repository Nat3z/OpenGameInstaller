export type SearchResult = {
  name: string;
  description: string;
  coverURL: string;
  downloadType: 'torrent' | 'direct' | 'magnet';
  downloadSize: number;
  appID: number;
  storefront: 'steam' | 'internal';
  filename?: string;
  downloadURL?: string;
  files?: {
    name: string;
    downloadURL: string;
  }[];
}

