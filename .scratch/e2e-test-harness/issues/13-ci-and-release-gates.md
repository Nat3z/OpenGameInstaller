# 13 — Gate pull requests and releases

**What to build:** Give contributors required Windows and Linux checks that run accessibility, fast product smoke, and the packaged Golden Journey, while nightly and release workflows publish useful reports and enforce reliability budgets.

**Blocked by:** 07 — Deliver the Golden Journey; 08 — Recover the Last Known-Good Installation; 09 — Resume an interrupted game download; 10 — Complete the fixture-game lifecycle; 11 — Prove offline updater and application behavior; 12 — Enforce retries, outcomes, retention, and process hygiene

**Status:** ready-for-agent

- [ ] Pull requests run both accessibility gates, unpackaged Application/Updater smoke, and packaged Golden Journey on Windows and Linux.
- [ ] Failed, Flaky, accessibility, budget, leaked-process, and infrastructure outcomes fail required checks.
- [ ] Nightly runs the broader deterministic failure and quarantined scenario matrix.
- [ ] Release workflow runs production packaging smoke and the full deterministic suite.
- [ ] HTML and machine-readable reports link retained CI artifacts.
- [ ] Ordinary UI, transfer, Golden Journey, PR-job, and full-job budgets are enforced and reported.
- [ ] CI never reads real user state or requires public internet for deterministic scenarios.
