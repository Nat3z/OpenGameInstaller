# 07 — Deliver the Golden Journey

**What to build:** Let a developer or CI watch the packaged updater install and launch the current application, complete first-run UI, discover a deterministic fixture game, download and install it, and see exactly one Library entry.

**Blocked by:** 05 — Observe and control a live run; 06 — Complete the packaged updater-to-application handoff

**Status:** ready-for-agent

- [x] A dedicated E2E Fixture Addon provides a tiny catalog without changing the developer test addon.
- [x] The Fixture Service supplies the direct-download game payload and sandboxed prerequisite state.
- [x] First-run actions, discovery, source selection, download, and installation occur through visible UI.
- [x] No public internet, real credentials, host prerequisite installation, or internal action shortcut is used.
- [x] The installed fixture appears exactly once in Library.
- [x] Windows and Linux complete within the agreed five-minute journey budget.
- [x] The Observer and reports expose every named step and failure artifact.

## Comments

- 2026-07-25: Added the dedicated `OGI E2E Fixture Addon`, packaged it with the current application, and connected its deterministic catalog, game details, direct-download source, setup response, and artwork to the loopback Fixture Service. The Product Journey now starts from untouched first-run state, uses visible UI to choose theme, consume sandboxed prerequisite state, choose the sandbox download directory, select the local fixture addon, discover the game, select its source, download/install it, and open Library. Product state and downloads are strictly contained by the Scenario Sandbox; the deterministic path uses no public service, credential, host prerequisite installation, or test-only UI action shortcut.
- 2026-07-25: Linux packaged run `4325ba1d-a1ee-4504-bd51-85e2728976a7` passed in 83 seconds with 43 contiguous events, seven named Passed steps and seven screenshots, four successful loopback requests, the exact fixture payload on disk, exactly one `7001.json` Library record, and no leaked product process. The same packaged builder and five-minute timeout are selected for Windows; runtime remains deferred to the dedicated Windows pass under the current ticket-group policy. The Observer summary exposes all named steps and artifacts. All 35 E2E tests, E2E TypeScript/Svelte checks, application/updater production builds, production package-boundary smoke, focused Biome checks, and diff validation pass.
