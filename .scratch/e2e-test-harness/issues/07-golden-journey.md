# 07 — Deliver the Golden Journey

**What to build:** Let a developer or CI watch the packaged updater install and launch the current application, complete first-run UI, discover a deterministic fixture game, download and install it, and see exactly one Library entry.

**Blocked by:** 05 — Observe and control a live run; 06 — Complete the packaged updater-to-application handoff

**Status:** ready-for-agent

- [ ] A dedicated E2E Fixture Addon provides a tiny catalog without changing the developer test addon.
- [ ] The Fixture Service supplies the direct-download game payload and sandboxed prerequisite state.
- [ ] First-run actions, discovery, source selection, download, and installation occur through visible UI.
- [ ] No public internet, real credentials, host prerequisite installation, or internal action shortcut is used.
- [ ] The installed fixture appears exactly once in Library.
- [ ] Windows and Linux complete within the agreed five-minute journey budget.
- [ ] The Observer and reports expose every named step and failure artifact.
