export * from './define';
export * from './envelope';
export * from './errors';
export * from './groups/addons';
export * from './groups/downloads';
export * from './groups/events';
export * from './groups/library';
export * from './groups/prompts';

import { AddonsGroup } from './groups/addons';
import { DownloadsGroup } from './groups/downloads';
import { EventsGroup } from './groups/events';
import { LibraryGroup } from './groups/library';
import { PromptsGroup } from './groups/prompts';

/** Every group in the protocol, for clients and schema export. */
export const Groups = {
  library: LibraryGroup,
  downloads: DownloadsGroup,
  prompts: PromptsGroup,
  events: EventsGroup,
  addons: AddonsGroup,
} as const;
export type Groups = typeof Groups;
