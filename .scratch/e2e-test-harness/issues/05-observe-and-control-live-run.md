# 05 — Observe and control a live run

**What to build:** Give a local developer an optional Svelte/Vite Observer Window that can start an Application Scenario, follow its steps and evidence live, survive refresh through event replay, stop execution safely, and rerun a failure without becoming the owner of runner lifetime.

**Blocked by:** 03 — Run the first observable Application Scenario

**Status:** ready-for-agent

- [ ] The dashboard server binds only to a random loopback port and requires a one-time run token.
- [ ] The dashboard replays existing JSONL and then follows validated live events.
- [ ] It displays scenario state, active step, elapsed time, outcomes, retries, latest screenshot, artifacts, and collapsible logs.
- [ ] Start, Stop, and rerun-failed controls send only coarse runner commands.
- [ ] Closing or refreshing the dashboard does not stop or corrupt the run.
- [ ] Stop produces Cancelled, stops new scheduling, and cleans the active process tree.
- [ ] The dashboard passes its accessibility scan.
- [ ] Side-by-side placement is best effort and never affects a scenario outcome.
