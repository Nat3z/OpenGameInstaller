type BaseRequiredFields = {
  name: string;
  manifest?: Record<string, any>;
};

export type SearchResult = BaseRequiredFields &
  (
    | {
        downloadType: 'torrent' | 'magnet';
        filename?: string;
        downloadURL?: string;
      }
    | {
        downloadType: 'direct';
        files?: {
          name: string;
          downloadURL: string;
          headers?: Record<string, string>;
        }[];
      }
    | {
        downloadType: 'request' | 'task' | 'empty';
      }
  );
