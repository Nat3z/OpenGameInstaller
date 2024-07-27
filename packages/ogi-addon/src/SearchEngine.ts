export type SearchResult = {
  name: string;
  description: string;
  coverURL: string;
  downloadType: 'torrent' | 'direct' | 'magnet';
  downloadSize: number;
  filename?: string;
  downloadURL?: string;
  files?: {
    name: string;
    downloadURL: string;
  }[];
}

