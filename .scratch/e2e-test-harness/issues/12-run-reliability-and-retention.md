# 12 — Enforce retries, outcomes, retention, and process hygiene

**What to build:** Make real application and updater runs classify instability and interruption accurately, retain the right diagnostics, expire ordinary evidence safely, and fail whenever a scenario leaks a descendant process.

**Blocked by:** 03 — Run the first observable Application Scenario; 04 — Run the first deterministic Updater Scenario

**Status:** ready-for-agent

- [ ] One automatic retry retains both attempts and produces Flaky when only the retry passes.
- [ ] Flaky remains distinct from Passed and maps to a failing required-check result.
- [ ] User Stop produces Cancelled; unterminated replay produces Aborted; assertion and infrastructure failures remain distinct.
- [ ] Successful sandboxes and passed videos are deleted.
- [ ] Failure-class, Flaky, Cancelled, and Aborted evidence is retained and linked.
- [ ] Retention keeps the newest 20 runs and all runs from the last 14 days, with pinning support.
- [ ] Leaked application, updater, game, or helper processes produce infrastructure failure.
- [ ] Quarantine metadata requires an issue, owner, and expiry; untracked skips are rejected.
