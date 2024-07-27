export interface SearchResult {
  name: string;
  description: string;
  coverURL: string;
  downloadURL: string;
  downloadType: 'torrent' | 'direct' | 'magnet';
  downloadSize: number;
  filename: string;
}