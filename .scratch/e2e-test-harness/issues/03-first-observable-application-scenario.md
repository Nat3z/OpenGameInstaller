# 03 — Run the first observable Application Scenario

**What to build:** Let a developer launch one unpackaged Application Scenario that creates a fresh Scenario Sandbox, drives a visible application action through WebdriverIO, records a replayable Run Event Log, captures useful evidence, and leaves no product process behind.

**Blocked by:** 01 — Make the application automation-accessible

**Status:** ready-for-agent

- [ ] The scenario launches from the project runner on Windows and Linux.
- [ ] It uses fresh isolated application state and never reads or changes a real profile.
- [ ] A user-visible action is performed through accessible UI semantics.
- [ ] Validated versioned JSONL events describe the run, scenario, attempt, steps, evidence, and outcome.
- [ ] A screenshot and application main/renderer logs are retained on failure.
- [ ] Replay reconstructs completed state and infers Aborted for an unterminated log.
- [ ] Teardown removes the complete application process tree and flags any leak.
