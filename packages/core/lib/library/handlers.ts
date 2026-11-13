import { LibraryGroup } from '@ogi-sdk/protocol';
import { Effect } from 'effect';
import { type Implementation, implement } from '../server/router';
import { Library } from './library';

/** Serves the `library` group from the core `Library` service. */
export const LibraryHandlers: Implementation<Library> = implement<
  typeof LibraryGroup,
  Library
>(LibraryGroup, {
  list: () => Effect.flatMap(Library, (library) => library.list),
  get: ({ appID }) => Effect.flatMap(Library, (library) => library.get(appID)),
  watch: () => Effect.flatMap(Library, (library) => library.watch),
  // launch / uninstall: not implemented until the launch pass, so they
  // answer MethodNotFound.
});
