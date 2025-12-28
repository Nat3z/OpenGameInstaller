// Slide content types - each slide can have multiple content blocks
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

