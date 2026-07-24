# 08 — Recover the Last Known-Good Installation

**What to build:** Ensure a user with a working installation remains able to launch it when a candidate update is interrupted, corrupt, unsafe, incomplete, cannot replace cleanly, crashes, times out, or never proves healthy.

**Blocked by:** 06 — Complete the packaged updater-to-application handoff

**Status:** ready-for-agent

- [ ] Download and staging do not mutate the working installation.
- [ ] Incomplete content, unsafe archive paths, and absent required files are rejected before replacement.
- [ ] Replacement retains a recoverable backup through the Startup Health deadline.
- [ ] Download, staging, replacement, crash, timeout, and invalid-health failures preserve or restore the Last Known-Good Installation.
- [ ] Recovery is visible in updater UI and the Run Event Log.
- [ ] The restored application launches successfully on Windows and Linux.
- [ ] All failure cases preserve diagnostics and do not leave product processes behind.
