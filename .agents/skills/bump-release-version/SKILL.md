---
name: bump-release-version
description: Prepare OpenGameInstaller application releases by deciding whether to bump only application/package.json or also updater/package.json, then commit and create the annotated v{application-version} tag. Use for release/version/tag requests in this repository, especially when deciding whether the independently versioned updater changed.
---

# Bump Release Version

Treat the application and updater as independently versioned release artifacts. The `v*` Git tag follows the application version; it does not imply that the updater version must change.

## Inspect the release scope

1. Read `application/package.json` and `updater/package.json`.
2. Check `git status`, existing `v*` tags, and the diff since the latest application release tag.
3. Find the commit that introduced the current updater version:

   ```bash
   git log -1 -G'"version":' --format=%H -- updater/package.json
   ```

4. Inspect committed and working-tree changes after that commit that can alter the updater artifact:

   - `updater/**`, excluding a version-only change already made for this release
   - packages imported by updater; currently `packages/logger/**`
   - root dependency or lockfile changes only when they change dependencies bundled into updater

5. State the decision and evidence before editing.

Do not bump the updater merely because the release workflow rebuilds it, the application changed, a new application tag is created, or release/CI documentation changed.

## Decide versions

- Always bump `application/package.json` for a new `v*` application release.
- Bump `updater/package.json` only when the inspection finds an unreleased updater-artifact change, or the user explicitly requests it.
- If the updater version was already bumped after its artifact changes, keep it as-is rather than bumping twice.
- Default to a patch bump. Honor an explicit version or semver level from the user.
- Never force the two package versions to match.

When evidence is ambiguous, explain the specific file and why it may affect the packaged updater. Ask only if choosing incorrectly could publish a changed updater under an old version.

## Apply the release

1. Edit only the selected package `version` fields. Preserve unrelated working-tree changes.
2. Do not update other package versions. Do not regenerate `bun.lock` for a version-only bump unless the user explicitly asks for lockfile synchronization.
3. Verify `git diff --check` and inspect the complete diff.
4. Commit only the intended version files using:

   - application only: `chore(application): bump version to X.Y.Z`
   - application and updater: `chore(release): bump application and updater versions`

5. Create an annotated `vX.Y.Z` tag on that commit, where `X.Y.Z` is the application version. Use the user's release description exactly as the tag message.
6. Verify the commit, tag target, tag contents, and clean/expected worktree state.

Do not push unless the user asks.
