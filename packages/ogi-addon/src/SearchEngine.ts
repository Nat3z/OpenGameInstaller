export interface SearchResult {
  name: string;
  description: string;
  coverURL: string;
  downloadURL: string;
  downloadType: 'torrent' | 'direct' | 'real-debrid';
  downloadSize: number;
}