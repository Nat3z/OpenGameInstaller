# 10 — Complete the fixture-game lifecycle

**What to build:** Let a user discover and install a harmless fixture game, launch its visible platform window, close it, and uninstall it while proving unrelated sandbox data remains untouched.

**Blocked by:** 07 — Deliver the Golden Journey

**Status:** ready-for-agent

- [ ] The installed fixture game runs independently of host Bun or Node.
- [ ] Launch occurs through application UI and produces a visible window plus sandbox marker.
- [ ] Closing the fixture returns control cleanly to the application.
- [ ] Uninstall occurs through visible UI.
- [ ] Game files and its Library entry are removed.
- [ ] Unrelated sentinel files remain unchanged.
- [ ] Fixture-game descendants are contained and cleaned on Windows and Linux.
