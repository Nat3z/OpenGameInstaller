type BaseRequiredFields = {
  name: string;
  manifest?: Record<string, any>;
  /**
   * Update-only hint for OGI's setup stage.
   * When false, OGI keeps existing files in place instead of moving them to `old_files`
   * before running update setup. Defaults to true/undefined behavior.
   */
  clearOldFilesBeforeUpdate?: boolean;
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
