# 09 — Resume an interrupted game download

**What to build:** Let a user restart the application after deterministic termination during a fixture-game download, see the interrupted work, resume it through UI, and complete one correct installation without duplicated Library state.

**Blocked by:** 07 — Deliver the Golden Journey

**Status:** ready-for-agent

- [ ] The Fixture Service exposes a deterministic partial-download termination point.
- [ ] The harness terminates the application process tree at that point without fabricating product state.
- [ ] Relaunch presents the interrupted work through visible UI.
- [ ] UI-driven resume produces the expected complete bytes.
- [ ] Exactly one Library entry exists and stale partial state is removed.
- [ ] Initial and resumed attempts appear in screenshots, logs, events, and reports.
- [ ] Windows and Linux pass without public internet.
