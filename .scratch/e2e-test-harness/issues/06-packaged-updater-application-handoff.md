# 06 — Complete the packaged updater-to-application handoff

**What to build:** Demonstrate a packaged E2E updater replacing a synthetic old installation with the packaged current application, forwarding the Run Descriptor, reconnecting user-level automation to the launched app, and waiting for an explicit Startup Health Signal.

**Blocked by:** 04 — Run the first deterministic Updater Scenario

**Status:** ready-for-agent

- [x] Windows and Linux builders produce synthetic old installations and packaged E2E updater/application artifacts.
- [x] The updater obtains the current artifact from the Fixture Service and performs the real launch handoff.
- [x] The Run Descriptor reference crosses the updater-to-application boundary without multiplying flags or environment variables.
- [x] Automation reconnects to the updater-launched application.
- [x] The application emits Startup Health only after required startup work and interactive main or first-run UI.
- [x] The updater keeps the prior installation recoverable until the bounded health signal arrives.
- [x] Ordinary production artifacts contain no active Run Descriptor or E2E hook path.
- [x] A production packaging smoke check proves the production boundary.

## Comments

- 2026-07-25: Implemented the packaged updater-to-application Product Journey. The harness now builds Linux and Windows synthetic old installations plus packaged E2E updater/application artifacts, serves the current artifact from the loopback Fixture Service, replaces the sandbox installation through a retained Last Known-Good copy, forwards one `OGI_RUN_DESCRIPTOR` reference, launches the installed application, waits for a bounded explicit Startup Health Signal after the main UI is interactive, reconnects automation through the child debugging endpoint, and drives visible Discovery navigation. Updater and application profiles are isolated, and ordinary production package inputs are scanned for active E2E hooks.
- 2026-07-25: Final Linux packaged run `e983bdfd-f210-4bc5-a97a-c097431f325f` passed with a contiguous 23-event completed log, exactly two Fixture Service requests, `v0.0.1-e2e` retained through health and released afterward, only `OGI_RUN_DESCRIPTOR` recorded as a forwarded E2E variable, a 68,164-byte post-reconnect screenshot, populated updater/application logs, and no leaked product process. Both platform builders were inspected from the retained Scenario Sandbox; Windows runtime remains deferred to the dedicated Windows pass under current policy. All 35 E2E tests, E2E TypeScript/Svelte checks, updater build, focused Biome checks, CJS syntax checks, production packaging smoke, and diff validation pass.
