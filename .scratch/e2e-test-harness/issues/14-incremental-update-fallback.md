# 14 — Exercise incremental update and full-download fallback

**What to build:** Let the updater apply a deterministic incremental update when its patch is valid and fall back safely to the full Verified Release when the patch is corrupt, without losing the working installation.

**Blocked by:** 08 — Recover the Last Known-Good Installation

**Status:** ready-for-agent

- [ ] The Fixture Service produces compatible old/current artifacts and deterministic incremental metadata.
- [ ] A valid incremental update reaches a healthy current application.
- [ ] A corrupt or interrupted patch is detected before it can strand the user.
- [ ] The updater visibly falls back to the full artifact and reaches Startup Health.
- [ ] Failure before successful fallback preserves the Last Known-Good Installation.
- [ ] Windows and Linux expose patch and fallback decisions in evidence.
