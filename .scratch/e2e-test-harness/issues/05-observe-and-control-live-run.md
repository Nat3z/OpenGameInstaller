# 05 — Observe and control a live run

**What to build:** Give a local developer an optional Svelte/Vite Observer Window that can start an Application Scenario, follow its steps and evidence live, survive refresh through event replay, stop execution safely, and rerun a failure without becoming the owner of runner lifetime.

**Blocked by:** 03 — Run the first observable Application Scenario

**Status:** ready-for-agent

- [x] The dashboard server binds only to a random loopback port and requires a one-time run token.
- [x] The dashboard replays existing JSONL and then follows validated live events.
- [x] It displays scenario state, active step, elapsed time, outcomes, retries, latest screenshot, artifacts, and collapsible logs.
- [x] Start, Stop, and rerun-failed controls send only coarse runner commands.
- [x] Closing or refreshing the dashboard does not stop or corrupt the run.
- [x] Stop produces Cancelled, stops new scheduling, and cleans the active process tree.
- [x] The dashboard passes its accessibility scan.
- [x] Side-by-side placement is best effort and never affects a scenario outcome.

## Comments

- 2026-07-25: Implemented the optional Svelte/Vite Observer Window and project runner command with random loopback binding, a single-use bootstrap token upgraded to an HttpOnly session cookie, authenticated WebSocket replay/live state, sandbox-contained artifact serving, scenario/step/timing/outcome/retry/screenshot/artifact/log presentation, and coarse Start, Stop, and rerun-failed commands. The standalone Electron observer attempts right-half side-by-side placement, exits independently when closed, and presentation launch failures cannot affect the scenario.
- 2026-07-25: Added portable cancellation-file control (with bounded forced fallback) so Stop records `Cancelled` after shared process-tree cleanup rather than fabricating failure. Real Linux Observer execution stopped Application Scenario run `074cbe21-924c-4303-975f-32de2ead25c9` during the active “Navigate to Discovery” UI step, emitted a contiguous 12-event completed log with `Cancelled` attempt/scenario/run outcomes, recorded `leaked: false`, and left PID/process group `843200` absent. A separate live Observer run `524829ae-c87c-49ca-9f44-3c2e0f88def7` passed with 14 validated events, the named-step screenshot, product logs, artifact links, and reconstructed totals/timing. Windows runtime remains deferred under current policy; loopback, Electron launch selection, cancellation-file signaling, and process containment remain platform-neutral or statically covered.
- 2026-07-25: Verification passed: 30 E2E unit tests, E2E TypeScript plus Svelte checks with zero errors/warnings, production Observer Vite build, Electron/Axe WCAG A/AA scan, focused Biome checks, and `git diff --check`. Unit coverage verifies single-use authentication, non-loopback rejection, replay/live state reduction, refresh/connection independence, coarse stop and rerun-failed behavior, `Cancelled` classification, and side-by-side window isolation.
