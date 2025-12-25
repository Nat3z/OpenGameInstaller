export type ChangelogContentBlock =
  | { type: 'title'; text: string }
  | { type: 'description'; text: string }
  | { type: 'image'; src: string; alt?: string; caption?: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'link'; text: string; url: string };

export interface ChangelogSlide {
  id: string;
  content: ChangelogContentBlock[];
}

export interface Changelog {
  version: string;
  date?: string;
  slides: ChangelogSlide[];
}

// Helper function to find a changelog by version
export function findChangelog(
  changelogs: Changelog[],
  version: string
): Changelog | undefined {
  return changelogs.find((c) => c.version === version);
}

/**
 * All application changelogs.
 * Add new versions at the top of the array.
 *
 * Each changelog can have multiple slides, and each slide
 * can have multiple content blocks (title, description, image, bullets, link).
 */
export const changelogs: Changelog[] = [
  {
    version: '2.5.0',
    date: '2025-12-24',
    slides: [
      {
        id: 'welcome',
        content: [
          { type: 'title', text: "What's New in v2.5.0" },
          {
            type: 'description',
            text: 'Learn more about the new features and improvements in this update!',
          },
        ],
      },
      {
        id: 'features',
        content: [
          { type: 'title', text: 'New Features' },
          {
            type: 'bullets',
            items: [
              'Added parallelized downloads for the download manager, making previously slow downloads much faster.',
              'Added an in-app updater for games, making it easier to download and install updates for your library.',
              'Added a torrent client called "Disabled" which will prevent torrent downloads from happening.',
              'Added this changelog modal to help you understand what has changed in the application.',
            ],
          },
        ],
      },
      {
        id: 'important',
        content: [
          { type: 'title', text: 'Important About Updater' },
          {
            type: 'description',
            text: `
            The in-app game updater will only update games that are have a new version available from the time you open this app.
            We will assume that the game you currently have installed is the latest version, so even if it is out-of-date as of now,
            an update indicator will not yet be shown. Please keep this in mind when utilizing this app.
            `,
          },
        ],
      },
    ],
  },
  {
    version: '2.1.0',
    date: '2025-01-15',
    slides: [
      {
        id: 'welcome',
        content: [
          { type: 'title', text: "What's New in v2.1.0" },
          {
            type: 'description',
            text: 'This update brings exciting new features and improvements to enhance your gaming experience.',
          },
        ],
      },
      {
        id: 'features',
        content: [
          { type: 'title', text: 'New Features' },
          {
            type: 'bullets',
            items: [
              'Improved download manager with real-time progress tracking',
              'Enhanced addon system with automatic updates',
              'New discovery page for finding games',
              'Better notification system',
            ],
          },
        ],
      },
      {
        id: 'improvements',
        content: [
          { type: 'title', text: 'Improvements & Fixes' },
          {
            type: 'bullets',
            items: [
              'Faster startup times',
              'Reduced memory usage',
              'Fixed various UI glitches',
              'Improved error handling',
            ],
          },
          {
            type: 'link',
            text: 'View full changelog on GitHub',
            url: 'https://github.com/Nat3z/OpenGameInstaller/releases',
          },
        ],
      },
    ],
  },
];

/**
 * Get the latest changelog
 */
export function getLatestChangelog(): Changelog | undefined {
  return changelogs[0];
}

/**
 * Get a changelog by version
 */
export function getChangelogByVersion(version: string): Changelog | undefined {
  return changelogs.find((c) => c.version === version);
}
