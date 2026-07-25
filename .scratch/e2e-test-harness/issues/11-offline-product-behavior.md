# 11 — Prove offline updater and application behavior

**What to build:** Show that an offline user can launch the Last Known-Good Installation through the updater, browse Library, and launch an installed fixture game without either product making unexpected remote requests.

**Blocked by:** 08 — Recover the Last Known-Good Installation; 10 — Complete the fixture-game lifecycle

**Status:** ready-for-agent

- [ ] Offline updater skips update work and launches the Last Known-Good Installation.
- [ ] Offline application presents its offline state without disabling Library.
- [ ] The installed fixture game launches successfully while offline.
- [ ] The Fixture Service rejects and records any unexpected request.
- [ ] Zero unexpected traffic is asserted rather than inferred.
- [ ] Windows and Linux expose the complete flow in Observer and reports.
