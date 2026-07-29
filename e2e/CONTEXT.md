# OpenGameInstaller Testing

This context names the concepts used to exercise and observe OpenGameInstaller as a complete desktop product.

## Language

**Observer Window**:
A test-harness-owned window that displays the live execution state and results of an end-to-end test run and provides coarse run controls. It is separate from, and must not ship with, the application or updater.
_Avoid_: Test window, app dashboard, debug window

**Application Scenario**:
An end-to-end scenario that launches and exercises the OpenGameInstaller application directly, without passing through the updater.
_Avoid_: App test

**Updater Scenario**:
An end-to-end scenario that exercises the updater independently, including its success and failure behavior.
_Avoid_: Updater test

**Product Journey**:
An end-to-end scenario that begins in the updater and continues into the application it installs and launches. Product Journeys are reserved for a small set of integration-critical paths.
_Avoid_: Full test, app test

**Fixture Service**:
A harness-controlled substitute for remote catalogs, release APIs, and downloads that gives scenarios deterministic success, failure, delay, and corruption behavior. Live third-party services are outside routine end-to-end runs.
_Avoid_: Mock server, fake internet

**Scenario Sandbox**:
A fresh, disposable boundary containing one scenario's user data, installation, downloads, configuration, processes, and fixture state. A scenario may copy in a seeded state but must never use a real user profile or installation.
_Avoid_: Test folder, temporary profile

**Golden Journey**:
The first and smallest Product Journey that proves the updater-to-application handoff and the application's core game-installation workflow. It updates a sandboxed older installation, launches the new application, completes first-run setup, installs a fixture game, and verifies Library visibility.
_Avoid_: Happy-path test, full test

**Run Event Log**:
The durable, ordered record of a test run's lifecycle, scenario, step, outcome, timing, retry, and artifact events. Observer views and reports reconstruct run state from this record.
_Avoid_: Console log, dashboard state, test output

**Flaky**:
A scenario outcome in which an initial attempt failed and the single automatic retry passed. Flaky is not equivalent to passed and fails required CI checks.
_Avoid_: Passed on retry, transient pass

**Run Descriptor**:
A validated description of one test run's sandbox and harness-controlled integration points, referenced across the updater-to-application handoff. It configures testability without replacing the real user workflow.
_Avoid_: Test config, environment flags

**Last Known-Good Installation**:
The most recent application installation that successfully completed startup and remains available for updater recovery until its replacement also proves healthy.
_Avoid_: Old version, backup copy

**Startup Health Signal**:
The application's explicit confirmation that required startup work has completed and either the main UI or first-run UI is ready for interaction. Process creation or window creation alone is not a health signal.
_Avoid_: Process started, window ready

**Live Service Scenario**:
A user-triggered scenario that exercises a real credentialed third-party provider and is excluded from required automated runs. Its result reports integration health but does not replace deterministic coverage.
_Avoid_: Integration test, manual test

**Deterministic Suite Check**:
An Observer-visible wrapper around one canonical deterministic CI check. It preserves the check's child scenario steps and artifacts while giving suite presets a stable ordered progress unit.
_Avoid_: Product Journey, unit test

**Cancelled**:
A terminal outcome produced when a user stops a run or scenario. It preserves diagnostic artifacts but does not imply that the product or assertion failed.
_Avoid_: Failed, aborted

**Aborted**:
A terminal outcome inferred when a runner or machine interruption leaves a run without its normal completion event. It preserves the recorded history and sandbox but carries no product verdict.
_Avoid_: Cancelled, failed

**Verified Release**:
A candidate application release obtained from the project's trusted immutable GitHub release and validated for complete download, safe extraction, and the presence of required application files.
_Avoid_: Downloaded release, valid archive
