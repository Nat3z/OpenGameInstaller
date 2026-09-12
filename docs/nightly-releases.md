# Nightly releases

Nightlies use the existing Bun, Electron Builder, GitHub Releases, npm and blockmap pipeline. Stable release tags and npm `latest` are never changed by this workflow.

## Channels

- **Stable** installs normal releases.
- **Unstable** includes manually published prereleases, excluding scheduled nightlies.
- **Nightly** follows the validated nightly channel manifest.
- **Bleeding Edge** retains the existing branch/commit source-build flow.

Run the setup executable with `--gui` to select a channel. Nightly application and setup packages embed a `-nightly.<run-id>` version, which initializes nightly membership on first launch. Existing explicit selection takes precedence. Selecting stable permits a downgrade from a nightly application/setup to the current stable release.

Selection is stored under the OS application-data directory at `OpenGameInstaller/channels/<installation-root-hash>.json`. Both executables use the same installation root. This survives application and setup replacement without depending on the backup directory. Existing `bleeding-edge.txt` and `COMMIT_EDGE.txt` markers migrate to unstable and source-build channels respectively. Invalid saved state opens a recovery prompt and requires an explicit channel choice instead of silently opting into another channel.

Portable copies retain their channel identity but do not install an updater. Download another portable build to update them, or use the nightly setup for automatic application updates. Offline launches do not require the manifest.

## Enablement

The schedule is `17 */2 * * *` UTC, but scheduled publication is disabled unless the repository variable `NIGHTLY_ENABLED` equals `true`. GitHub scheduling is best-effort, not an exact two-hour guarantee.

1. Merge nightly support after the PR's Windows/Linux nightly dry run and tarball validation pass.
2. Dispatch **Nightly** on `main` with `dry_run=true` to verify the current main revision.
3. Dispatch with `dry_run=false`. This requires the existing `NPM_TOKEN` to have publication rights for all SDK packages. Publication is rejected outside this repository's `main` branch.
4. Install the Windows/Linux nightly setup, then validate a second nightly update, an application-only update reusing its installer, offline launch, setup replacement and an explicit switch back to stable.
5. Confirm GitHub `releases/latest` and npm `latest` still point to stable, then set `NIGHTLY_ENABLED=true`.

PRs touching the nightly pipeline run a forced, credential-free dry run. Only the separate main-only publishing job receives npm credentials and write permissions. This does not automatically merge or publish the PR.

## Build Identity

One checked-out SHA and GitHub workflow run ID are used throughout. Versions are stamped **after** the frozen dependency install and are never committed: application `4.3.2-nightly.<run-id>`, SDK `5.2.1-nightly.<run-id>`, and updater `2.2.1-nightly.<run-id>` are examples based on the current manifests' next patch. A retry uses the original identity. Windows numeric file versions omit the run ID; application metadata retains full SemVer.

Change detection compares against the last successfully promoted manifest. It includes desktop and workspace sources, root manifests/lockfile and workflow inputs. SDK changes propagate to their dependents, with exact internal nightly dependency pins. The installer is rebuilt only when its sources, shared logger/channel package or common dependency/build inputs change. Other nightlies reuse the previous validated nightly installer and its immutable URLs.

Install the SDK using:

```sh
bun add ogi-addon@nightly
```

Changed packages publish in dependency order under `nightly-staging`. After all artifacts validate, their `nightly` dist-tags advance. npm cannot update multiple dist-tags atomically; the desktop channel manifest advances only after every requested tag update succeeds. Unchanged SDK packages retain their existing channel versions.

## Publication and Recovery

Every desktop build gets an immutable `nightly-<run-id>` prerelease with the existing asset names and blockmaps. SHA-256 and size metadata are recorded in `nightly.json`. The GitHub release named `nightly` has a JSON body containing the complete authoritative channel manifest. Updating this one body atomically promotes the application, installer and SDK version map. Clients fetch it directly through the releases-by-tag API, not by sorting prereleases.

The pipeline validates tarball entrypoints, installs the package set together, validates blockmap sizes, checks hashes and rejects missing platform assets. Publication rechecks validated bytes. A release starts as a draft and is made public only after all required uploads exist. Installer reuse is checked before promotion. Failed builds/publications leave the previous desktop pointer unchanged.

For partial npm/upload failures, rerun the failed publishing job using the same validated artifacts. Existing npm versions and assets must match their original integrity; they are never overwritten. A full rebuild can produce different bytes under the same run ID and will be rejected. Start a fresh run in that case. Reruns older than the promoted build cannot move the channel backwards.

After successful promotion, retention keeps the newest three immutable desktop releases plus the installer still referenced by the manifest (at most four immutable prereleases plus the pointer). This bounds the feed for older stable clients that do not paginate. The pipeline refuses further publication at eight public immutable nightlies, including orphans from failed runs; investigate and remove unreferenced orphans before retrying. Never remove the manifest's application or installer release. Old clients whose artifact bases were removed use full downloads.

Disable `NIGHTLY_ENABLED` to pause scheduling. To recover from a bad promoted nightly, publish a new fixed main revision; do not replace bytes under an existing artifact URL. Stable remains available through the channel picker throughout.
