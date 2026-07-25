# 04 — Run the first deterministic Updater Scenario

**What to build:** Let a developer launch one unpackaged Updater Scenario in a Scenario Sandbox, configure it through the E2E-only Run Descriptor, serve its remote response from a minimal Fixture Service, drive visible updater UI, and receive the same replayable evidence as an Application Scenario.

**Blocked by:** 02 — Make the updater automation-accessible; 03 — Run the first observable Application Scenario

**Status:** ready-for-agent

- [x] The strict Run Descriptor rejects unknown fields and paths outside the Scenario Sandbox.
- [x] The Fixture Service binds to an allocated loopback port and records requests.
- [x] The updater reads fixture release information without contacting public internet.
- [x] WebdriverIO performs a visible updater interaction and uses condition-based waits.
- [x] Native-dialog test responses preserve the initiating UI action and record requested options.
- [x] Updater, fixture, and process evidence appears in the Run Event Log.
- [x] Teardown contains and cleans updater and helper processes on Windows and Linux.

## Comments

- 2026-07-25: Implemented the first deterministic unpackaged Updater Scenario with a strict sandbox-contained Run Descriptor, allocated loopback Fixture Service, accessible Stable-channel interaction, queued native-dialog response/request recording, fixture-only release lookup, validated Run Event Log events, screenshot and updater/fixture evidence, and shared bounded process-tree cleanup. Final Linux run `c9769b66-c19e-4341-b2cc-c9496dfd5391` passed with one `GET /repos/Nat3z/OpenGameInstaller/releases` request, a contiguous 20-event completed log, populated main/renderer logs, recorded native-dialog options, a valid 800×673 PNG, a closed fixture port, and recorded PID/process group `825875` absent after teardown. All 22 E2E unit tests, E2E typechecking, updater build, focused Biome checks, and diff validation pass. Windows runtime execution remains deferred to the dedicated Windows pass under current policy; Windows Job Object launch and multi-PID cleanup paths remain statically covered.
