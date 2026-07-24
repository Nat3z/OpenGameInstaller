# 16 — Add user-triggered Live Service Scenarios

**What to build:** Let a developer explicitly select and run real credentialed provider checks from CLI or the Observer Window while preventing accidental shared-CI execution or secret leakage.

**Blocked by:** 05 — Observe and control a live run; 07 — Deliver the Golden Journey; 12 — Enforce retries, outcomes, retention, and process hygiene

**Status:** ready-for-agent

- [ ] CLI and Observer expose a clearly separate Live Service Scenario selection.
- [ ] Starting requires explicit confirmation and validates required credentials.
- [ ] Credentials are never inherited automatically into shared required CI.
- [ ] Events, logs, descriptors, reports, and screenshots redact secrets where feasible.
- [ ] Live Service results report external integration health but do not replace deterministic coverage.
- [ ] Live Service outcomes do not block normal PR or nightly suites.
