# 08 — Recover the Last Known-Good Installation

**What to build:** Ensure a user with a working installation remains able to launch it when a candidate update is interrupted, corrupt, unsafe, incomplete, cannot replace cleanly, crashes, times out, or never proves healthy.

**Blocked by:** 06 — Complete the packaged updater-to-application handoff

**Status:** ready-for-review

- [x] Download and staging do not mutate the working installation.
- [x] Incomplete content, unsafe archive paths, and absent required files are rejected before replacement.
- [x] Replacement retains a recoverable backup through the Startup Health deadline.
- [x] Download, staging, replacement, crash, timeout, and invalid-health failures preserve or restore the Last Known-Good Installation.
- [x] Recovery is visible in updater UI and the Run Event Log.
- [x] The restored application launches successfully on Windows and Linux.
- [x] All failure cases preserve diagnostics and do not leave product processes behind.

## Comments

- 2026-07-25: Implemented a strict Last Known-Good recovery matrix for interrupted download, incomplete content, unsafe archive paths, missing required files, replacement failure, candidate crash, Startup Health timeout, and invalid Startup Health. Candidates are fully validated in staging before replacement; replacement retains the prior installation until valid health; every failure restores and launches the synthetic working installation, shows recovery through the updater's accessible status UI, records typed recovery phases and diagnostics in the Run Event Log, captures a screenshot, and reports `leaked: false` after bounded process-tree cleanup.
- 2026-07-25: All eight Linux recovery cases passed through the packaged updater UI, and the packaged Golden Journey regression also passed. The final retained crash run is `/tmp/ogi-packaged-handoff-b48d2029-c433-47b3-bdf0-6714585c59ec-XAYXQ4`; it records the candidate exit, restored `v0.0.1-e2e`, successful restored launch, screenshot/log/report evidence, and no leaked process. Windows runtime remains deferred under the ticket-group policy; the Windows descriptor, `.cmd` Last Known-Good launcher, PowerShell Job Object runner, and cleanup paths are statically covered.
- 2026-07-25: Verification passed: 43 E2E unit tests, E2E TypeScript and Svelte checks with zero errors/warnings, updater build, CommonJS syntax checks, focused Biome checks, production-package boundary scan with no active E2E hooks, and `git diff --check`.
- 2026-07-25: Review fixes verified: replacement failure now removes the working launcher and leaves only candidate version metadata before throwing, proving restoration from a partially mutated installation. Recovery Run Events preserve their updater-side timestamps and are written before the recovery screenshot, step completion, process shutdown, and fixture shutdown. All 8 packaged Linux recovery cases, the packaged Golden Journey, 44 E2E unit tests, E2E TypeScript, focused Biome and CommonJS checks, the production-package boundary scan, and `git diff --check` passed. Windows runtime remains deferred under the ticket-group policy.
