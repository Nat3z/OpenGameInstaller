type BaseRequiredFields = {
  name: string;
  manifest?: Record<string, any>;
  /** Optional total size in bytes when known (e.g. from addon search). Shown on store/update UI and as initial download size until backend sends real fileSize. */
  sizeInBytes?: number;
};

export type SearchResult = BaseRequiredFields &
  (
    | {
        downloadType: 'torrent' | 'magnet';
        filename: string;
        downloadURL: string;
      }
    | {
        downloadType: 'direct';
        files: {
          name: string;
          downloadURL: string;
          headers?: Record<string, string>;
        }[];
      }
    | {
        downloadType: 'task';
        taskName: string;
      }
    | {
        downloadType: 'request' | 'empty';
      }
  );
