# End-to-end test harness

Status: ready-for-agent

## Problem Statement

OpenGameInstaller has two user-facing Electron products—the updater and the application—but no dependable way to prove their complete Windows and Linux behavior. The updater currently has no tests, and the application’s important workflows cross renderer UI, Electron APIs, local files, child processes, downloads, addons, and external services. A regression can therefore pass typechecking and packaging while still preventing installation, destroying a working application during update, losing an interrupted game download, or leaving users with an inaccessible interface.

Developers also lack a practical way to watch an end-to-end run. When a workflow fails, there is no unified view of the active scenario and step, outcomes, retries, screenshots, product logs, fixture traffic, or retained filesystem state. Tests that depend on real internet services or real user configuration would be slow, unsafe, and irreproducible.

## Solution

Build one project-owned E2E harness for Windows and Linux. It will drive the visible application and updater interfaces through WebdriverIO, execute each scenario inside a fresh Scenario Sandbox, replace routine remote dependencies with a deterministic Fixture Service, and record every run as a durable versioned Run Event Log.

The harness will support Application Scenarios and Updater Scenarios independently, plus a deliberately small set of Product Journeys that begin in the updater and continue into the application it installs and launches. Test actions occur through UI; a single validated Run Descriptor provides only sandbox configuration, deterministic integration points, native-dialog responses, readiness observation, and the updater-to-application automation handoff.

For local use, an optional Svelte/Vite Observer Window will open beside the product and show live progress, execution statistics, screenshots, logs, and artifacts. It will provide coarse start, stop, and rerun-failed controls without owning runner lifetime. The same runner will operate headlessly in CI and generate machine-readable and HTML reports.

The first Product Journey will update a synthetic older installation through a full fixture release, launch the real current packaged E2E application, complete first-run UI, install a tiny fixture game, and verify Library visibility. Subsequent milestones enforce updater recovery, interrupted-download recovery, the complete fixture-game lifecycle, and offline operation.

## User Stories

1. As an OpenGameInstaller maintainer, I want one E2E harness for both products, so that updater and application behavior is evaluated consistently.
2. As a developer, I want Application Scenarios to launch the app directly, so that most app failures can be diagnosed without updater overhead.
3. As a developer, I want Updater Scenarios to exercise the updater independently, so that release handling and recovery failures are localized.
4. As a release owner, I want a small set of Product Journeys, so that updater-to-application integration is proven without making every Application Scenario slow.
5. As a Windows user, I want required scenarios to run on Windows, so that installer and process behavior matches my supported platform.
6. As a Linux or Steam Deck user, I want required scenarios to run on Linux, so that AppImage permissions and launch behavior are protected.
7. As a developer, I want each scenario to use a fresh Scenario Sandbox, so that tests cannot damage my real profile, installation, downloads, or configuration.
8. As a CI operator, I want scenario processes contained as one tree, so that a leaked updater, app, game, or helper cannot poison later tests.
9. As a developer, I want successful sandboxes removed, so that ordinary runs do not consume unbounded disk space.
10. As a developer debugging a failure, I want failure-class sandboxes preserved, so that I can inspect the exact state that produced the result.
11. As a developer, I want to pin important runs, so that automatic retention cannot delete evidence I still need.
12. As a test author, I want deterministic fixture releases, catalogs, downloads, and prerequisites, so that routine scenarios never depend on public internet health.
13. As a test author, I want the Fixture Service to simulate delays, interruptions, truncation, corruption, and errors, so that recovery paths are reproducible.
14. As a maintainer, I want unexpected fixture traffic to fail a scenario, so that offline behavior and dependency boundaries are actually proven.
15. As an addon developer, I want a dedicated E2E Fixture Addon separate from the developer playground addon, so that experiments cannot destabilize required tests.
16. As a developer, I want the synthetic fixture game to open a visible window, so that launch behavior resembles a real user-visible game.
17. As a developer, I want the fixture game to write a sandbox marker, so that successful launch can be observed without inspecting app internals.
18. As a user receiving an update, I want downloads staged away from my working installation, so that an incomplete candidate cannot damage it.
19. As a user receiving an update, I want unsafe or incomplete archives rejected, so that only a Verified Release can replace my app.
20. As a user receiving an update, I want the Last Known-Good Installation retained until the new app proves healthy, so that startup failure can be rolled back.
21. As a user, I want successful startup to require an explicit Startup Health Signal, so that mere process or window creation is not mistaken for a working app.
22. As a user, I want the updater to restore the prior installation after candidate crash or timeout, so that I am not stranded without a working app.
23. As a user with an interrupted game download, I want the app to present and resume it after restart, so that partial progress is not lost.
24. As a user resuming a download, I want installation to finish exactly once, so that files and Library entries are not duplicated or corrupted.
25. As a user, I want a fixture game install/launch/uninstall journey, so that the entire local game lifecycle is protected.
26. As a user uninstalling a game, I want unrelated files preserved, so that a path-handling regression cannot delete other data.
27. As an offline user, I want the updater to launch my Last Known-Good Installation without network access, so that connectivity loss does not block the app.
28. As an offline user, I want Library and local game launch to remain usable, so that installed content is not unnecessarily network-dependent.
29. As a test author, I want actions performed through visible UI, so that scenarios test user behavior rather than internal shortcuts.
30. As a test author, I want hooks limited to setup and observation, so that testability does not bypass the behavior under test.
31. As a test author, I want accessible roles and names to be the preferred selectors, so that tests are resilient and accessibility improves with testability.
32. As a user of assistive technology, I want unlabeled or incorrectly modeled controls to block CI, so that accessibility regressions cannot silently ship.
33. As a test author, I want condition-based waits instead of sleeps, so that scenarios are reliable across different machine speeds.
34. As a test author, I want timeout errors to name the unmet condition, so that failures are actionable.
35. As a developer, I want a screenshot after every named step, so that I can see the UI state leading to a failure.
36. As a developer, I want main-process, renderer, fixture, and process logs collected together, so that cross-boundary failures can be traced.
37. As a developer, I want failed-run video retained and passed-run video discarded, so that useful evidence is available without excessive storage.
38. As a developer, I want the Run Event Log to be append-only JSONL, so that a crash does not erase previously recorded run history.
39. As a dashboard user, I want refresh to replay the Run Event Log, so that reconnecting does not lose scenario or step history.
40. As a tooling maintainer, I want versioned validated run events, so that saved runs remain interpretable as the harness evolves.
41. As a developer, I want Aborted, Cancelled, Failed, Flaky, and infrastructure failure to remain distinct, so that reports state what actually happened.
42. As a maintainer, I want one automatic retry to produce Flaky rather than Passed, so that retries expose instability instead of hiding it.
43. As a maintainer, I want Flaky outcomes to fail required CI, so that intermittent regressions cannot become normal.
44. As a maintainer, I want quarantine to require an issue, owner, and expiry, so that disabled coverage is visible and temporary.
45. As a developer, I want an Observer Window beside the product, so that I can watch the current scenario and step while the UI is exercised.
46. As a dashboard user, I want pass/fail/skip/flaky totals and timings, so that I can assess run health at a glance.
47. As a dashboard user, I want scenario and step timelines with the latest screenshot, so that I can follow execution without reading raw logs.
48. As a dashboard user, I want artifact links and collapsible live logs, so that deeper evidence is close to the relevant failure.
49. As a dashboard user, I want to select and start a suite, stop a run, and rerun failures, so that common local workflows need no separate terminal commands.
50. As a CI operator, I want the Observer Window to be optional, so that the same suite runs reliably without a desktop dashboard.
51. As a CI operator, I want closing the Observer Window not to stop execution, so that presentation cannot corrupt runner state.
52. As a security-conscious developer, I want the dashboard server bound only to loopback with a one-time token, so that local test controls are not exposed to the network.
53. As a release owner, I want E2E hooks compiled out of production artifacts, so that powerful path and endpoint overrides cannot ship to users.
54. As a release owner, I want a production packaging smoke test, so that exclusion of E2E configuration is continuously verified.
55. As a provider integrator, I want user-triggered Live Service Scenarios, so that real credentialed integrations can be checked when needed.
56. As a provider user, I want Live Service credentials explicitly supplied and redacted, so that secrets are not inherited into shared CI or retained artifacts.
57. As a maintainer, I want direct downloads covered in the initial required suite, so that the core deterministic installation path is protected first.
58. As a maintainer, I want a later deterministic local torrent/magnet scenario, so that torrent behavior is covered without public swarm variability.
59. As a pull-request author, I want the Golden Journey to block Windows and Linux merges, so that cross-product breakage is caught before merging.
60. As a CI operator, I want explicit runtime budgets, so that gradual suite slowdown remains visible.

## Implementation Decisions

- Create a dedicated E2E workspace that owns orchestration, event contracts, sandbox management, fixtures, platform launch adapters, scenarios, reports, and the Observer Window. Product-side hooks remain owned by the updater and application.
- Use WebdriverIO with its Electron service for packaged and unpackaged Windows/Linux automation. Wrap its lifecycle in project-owned abstractions and events rather than coupling the Observer Window to WebdriverIO presentation.
- Keep scenarios sequential per machine in version one. Allocate ports and paths dynamically so parallel workers can be introduced later without redesigning contracts.
- Use three scenario classes: Application Scenario, Updater Scenario, and Product Journey.
- Use the highest available action seam: visible product UI. Setup and observation enter through one new high-level seam, the validated Run Descriptor. External behavior enters through one high-level seam, the Fixture Service.
- Pass one Run Descriptor reference through one explicit environment variable. The updater forwards it during the genuine application launch handoff.
- Validate the Run Descriptor strictly. Reject unknown fields and any configured path escaping the Scenario Sandbox.
- Compile Run Descriptor support, endpoint overrides, queued native-dialog behavior, health observation, and automation handoff out of production artifacts.
- Build separate packaged E2E artifacts for Product Journeys and retain an ordinary production-artifact packaging smoke test.
- Build each Scenario Sandbox with isolated user data, installation, downloads, configuration, fixture state, and process containment.
- Use Windows job-object or equivalent containment and Linux process groups. Treat any surviving descendant as an infrastructure failure.
- Retain failure-class, Flaky, Cancelled, and Aborted sandboxes. Delete successful sandboxes. Keep the newest 20 local runs and all runs from the last 14 days, whichever retains more; pinned runs are exempt.
- Bind the Fixture Service to loopback on an allocated port. It will provide GitHub Releases-compatible metadata, current/synthetic artifacts, catalogs, game payloads, prerequisites, deterministic network faults, request history, and unexpected-request rejection.
- Keep the existing developer test addon separate. Build a minimal deterministic E2E Fixture Addon with no public-internet dependency.
- Generate a small synthetic old installation for the Golden Journey; do not commit historical cross-platform binaries. Replace it with the real current packaged E2E app.
- Use a platform-specific, independently runnable fixture game with a visible window and sandbox launch marker.
- Initiate native dialogs through the product UI but resolve them in unattended E2E builds from queued Run Descriptor responses. Record and assert the requested dialog configuration.
- Preserve the Last Known-Good Installation until a replacement emits a bounded Startup Health Signal after required startup tasks/migrations and interactive main or first-run UI.
- Stage and validate a complete candidate before replacement. Reject incomplete download, unsafe archive paths, and missing required files. Immutable GitHub releases remain the production trust boundary.
- Make `events.jsonl` the canonical append-only Run Event Log and generate `summary.json` after normal completion.
- Version and validate every event. Include run ID, monotonic sequence number, timestamp, event type, and typed payload. Consumers tolerate unknown future event types.
- Represent run, suite, scenario, attempt, step, assertion, artifact, process, fixture request, retry, cancellation, and completion in the event model.
- Use the terminal outcomes Passed, Failed, Flaky, Skipped, Cancelled, Aborted, and Infrastructure Failed. A single automatic retry that passes produces Flaky and still fails required CI.
- Infer Aborted on replay when a prior runner or machine interruption left no completion event; do not rewrite historical JSONL.
- Implement Stop as cancellation: stop scheduling, request graceful shutdown, then force-clean the scenario process tree after a deadline.
- Build the Observer Window with Svelte and Vite, without importing application frontend state or components.
- Serve the Observer Window over a random loopback port, protect it with a per-run one-time URL token, and stream replay/live state plus coarse commands over WebSocket.
- Keep runner execution independent of Observer lifetime. Best-effort side-by-side placement is presentation-only and never affects outcomes.
- Lay out the Observer with run controls/elapsed time at top, scenarios at left, current step/timeline/screenshot at center, and totals/retries/artifacts/logs at right.
- Allow Observer controls for select/start, stop, and rerun failures only. Do not add pause-between-step, approval, or direct product controls.
- Use Svelte/Vite accessibility standards in the Observer from its first version.
- Expose credentialed providers only as explicit Live Service Scenarios selectable through CLI or Observer. Require confirmation and credentials, redact secrets, and exclude them from shared required CI.
- Enforce approximate budgets of 30 seconds for normal UI steps, two minutes for fixture transfers/updates, five minutes for the Golden Journey, ten minutes per required PR OS job, and 25 minutes per full/nightly OS job.

## Testing Decisions

- A good E2E test acts through visible UI and asserts user-visible output or external effects such as files, process launch, network silence, and retained/restored installation state. It does not call product internals to perform actions.
- Test hooks are acceptable only for sandbox setup, deterministic dependency configuration, queued OS-dialog results, readiness/state observation, evidence collection, and the updater-to-application automation handoff.
- Prefer accessible roles and names, followed by labels or semantic text. Use stable test IDs only when semantics cannot disambiguate. Never select through CSS styling, DOM position, or arbitrary delays.
- Perform a complete accessibility and selector-readiness pass over both product renderers before scenario authoring. Automated accessibility violations block CI.
- Use condition-based waits only. A timeout records the condition being awaited and immediately captures evidence.
- Capture a screenshot after every named step, main/renderer logs, fixture request history, redacted Run Descriptor, execution video, sandbox inventory/output, machine-readable results, and HTML report.
- Delete passed-scenario video with the successful sandbox. Preserve all evidence for Failed, Flaky, Cancelled, Aborted, and infrastructure-failed outcomes.
- Redact Live Service credentials and secret UI values from event payloads, logs, descriptors, reports, and screenshots where feasible.
- Golden Journey coverage uses a full download first. Incremental update success and corrupt-patch fallback are separate Updater Scenarios.
- Golden Journey uses sandboxed prerequisite state while still completing first-run UI. Platform prerequisite installation is covered separately with Fixture Service payloads.
- Required initial provider coverage uses direct download. Add a deterministic local torrent/magnet scenario later. Real credentialed providers remain user-triggered Live Service Scenarios.
- Milestone 1 tests the packaged Golden Journey from synthetic old install through Library visibility.
- Milestone 2 tests interrupted/corrupt updater recovery and Last Known-Good restoration.
- Milestone 3 tests process termination during game download followed by UI resume without duplication or corruption.
- Milestone 4 tests install, visible fixture-game launch, close, uninstall, and unrelated-file preservation.
- Milestone 5 tests updater and application offline behavior while rejecting unexpected traffic.
- Application and Updater smoke scenarios use built-unpackaged artifacts for speed and diagnostics. Product Journeys and packaging smoke use packaged artifacts.
- Every pull request runs accessibility, unpackaged smoke, and packaged Golden Journey on both Windows and Linux.
- Nightly runs the broader deterministic failure matrix, incremental updates, and quarantined scenarios.
- Release workflow runs production packaging smoke and the full deterministic suite.
- Failed, Flaky, accessibility, timeout-budget, leaked-process, and infrastructure-failed outcomes fail required checks.
- Quarantine requires a linked local issue, named owner, and expiry date and continues to run nightly. Untracked skips are prohibited.
- Prior art exists in the application’s current startup/splash transitions, download persistence/restart modules, failed-setup recovery, updater full/incremental/fallback paths, existing test addon, and Windows/Linux release workflow. There is no existing E2E framework to preserve.

## Out of Scope

- macOS in the initial required matrix.
- Admin/elevated installation and automation of elevation prompts.
- Operating-system code-signing, SmartScreen, or platform trust verification.
- Pixel-perfect visual regression baselines.
- CPU, memory, startup-performance, or download-throughput benchmarking.
- Parallel scenario workers in version one.
- Real credentialed provider calls in required PR, nightly, or shared CI.
- Making the Observer Window part of the shipped application or updater.
- Pausing between steps, manual approval gates, or controlling product actions from the Observer.
- Running every Application Scenario through the updater.
- Testing every download provider in the first milestone.
- Using public internet assets in deterministic scenarios.

## Further Notes

- The implementation order is captured in the effort’s numbered issue files, beginning with runner/event contracts and the required accessibility pass before scenario authoring.
- The Golden Journey must pass from a clean checkout on both required platforms without public internet or real user state.
- The design is governed by the E2E glossary and the ADRs covering WebdriverIO, the Run Descriptor handoff, Last Known-Good recovery, and immutable GitHub release trust.
- The accepted test seams are intentionally few: visible UI for actions, one Run Descriptor for setup/observation, and one Fixture Service for external systems.
- A successful first version is not merely a green scenario. It must also prove replayable observation, complete process cleanup, production exclusion of E2E hooks, and useful retained evidence when anything fails.
- Current local implementation policy: Windows runtime execution is deferred to a later dedicated Windows test pass. Record Windows verification as deferred, do not claim it ran, and do not let its absence alone block ticket progression; continue to implement and statically cover Windows-specific paths while running available verification on Linux.
