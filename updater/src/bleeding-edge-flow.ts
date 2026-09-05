import { Effect } from 'effect';

export type BleedingEdgeSelection = {
  readonly branch: string;
  readonly commit: string;
};

export function normalizeBranch(branch: string): string {
  return branch.trim().replace(/^refs\/(?:heads\/|remotes\/origin\/)/, '');
}

export function normalizeBleedingEdgeSelection(
  branch: unknown,
  commit: unknown,
  defaultBranch: string
): BleedingEdgeSelection {
  const normalizedBranch = typeof branch === 'string' ? branch.trim() : '';
  return {
    branch: normalizeBranch(normalizedBranch) || defaultBranch,
    commit: typeof commit === 'string' ? commit.trim() : '',
  };
}

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
