import { Effect } from 'effect';

export type BleedingEdgeSelection = {
  readonly branch: string;
  readonly commit: string;
};

export function selectAndBuildBleedingEdge<A, PersistError, BuildError>(
  selection: BleedingEdgeSelection,
  persist: (
    selection: BleedingEdgeSelection
  ) => Effect.Effect<void, PersistError>,
  build: (selection: BleedingEdgeSelection) => Effect.Effect<A, BuildError>
): Effect.Effect<A, PersistError | BuildError> {
  return Effect.gen(function* () {
    yield* persist(selection);
    return yield* build(selection);
  });
}
