# 04 — Run the first deterministic Updater Scenario

**What to build:** Let a developer launch one unpackaged Updater Scenario in a Scenario Sandbox, configure it through the E2E-only Run Descriptor, serve its remote response from a minimal Fixture Service, drive visible updater UI, and receive the same replayable evidence as an Application Scenario.

**Blocked by:** 02 — Make the updater automation-accessible; 03 — Run the first observable Application Scenario

**Status:** ready-for-agent

- [ ] The strict Run Descriptor rejects unknown fields and paths outside the Scenario Sandbox.
- [ ] The Fixture Service binds to an allocated loopback port and records requests.
- [ ] The updater reads fixture release information without contacting public internet.
- [ ] WebdriverIO performs a visible updater interaction and uses condition-based waits.
- [ ] Native-dialog test responses preserve the initiating UI action and record requested options.
- [ ] Updater, fixture, and process evidence appears in the Run Event Log.
- [ ] Teardown contains and cleans updater and helper processes on Windows and Linux.
