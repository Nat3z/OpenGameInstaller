# 02 — Make the updater automation-accessible

**What to build:** Make the complete updater UI usable by assistive technology and stable user-level automation. Its channel selection, progress, failure, recovery, and status surfaces should be discoverable without DOM-structure or styling selectors.

**Blocked by:** None — can start immediately

**Status:** needs-triage

- [x] Updater controls and status regions expose correct roles, accessible names, values, and states.
- [x] Channel selection, progress, error, and recovery presentation are included.
- [x] Stable test IDs exist only where accessible semantics remain ambiguous.
- [x] An automated updater accessibility scan passes and is capable of blocking regressions.
- [x] Any unavoidable exception records its justification and owner.

## Comments

- 2026-07-24: Completed the updater semantic and keyboard-focus pass for channel selection, bleeding-edge branch/commit selection, progress, failure alerts, and recovery status. No test IDs or accessibility exceptions were needed.
- 2026-07-24: Added a deterministic Electron/WebdriverIO Axe gate to the combined accessibility command. The TypeScript runner uses Effect for typed process failure and scoped Axe installation/cleanup. Verified the focused updater gate, the complete application-plus-updater accessibility gate, E2E typechecking, updater build, and focused Biome checks.
- 2026-07-24: Review follow-up replaced text-inferred live-region behavior with typed production IPC payloads and permanent status/alert regions, switched the fixture to the compiled production preload, split status coverage into fresh sandboxed UI-driven states, added bounded Effect-managed asynchronous process-tree cleanup, cleared commit selection when users edit the commit value, and made Axe installation preserve any pre-existing file. The revised E2E and updater TypeScript build passes. Runtime re-verification is pending explicit approval to launch Electron with the existing `--no-sandbox` test argument; this host's `chrome-sandbox` helper is mode 755 rather than setuid, and removing the argument caused Chrome to exit before session creation.
- 2026-07-25: Runtime review follow-up is verified. The updater Axe command passed four fresh Effect-managed processes covering channel and bleeding-edge selection, progress, explicit failure severity, and recovery through the compiled production preload and production-shaped IPC. Final static checks passed, and the runner removed every Scenario Sandbox and generated Axe asset. The prior runtime-pending note is superseded.
- 2026-07-25: Final independent review follow-up now verifies POSIX process groups and captured Windows descendant PIDs are gone after bounded graceful/forced cleanup, evaluates Axe directly from `node_modules` without modifying updater packaging inputs, focuses the visible failure heading, normalizes commit selection across manual edits and list refreshes, and separates continuously updated progressbar values from five-second/ten-percent coalesced live announcements. E2E typechecking, updater build, focused Biome, diff validation, and the packaging-input check pass; runtime criteria are reopened pending the revised four-state Electron run.
- 2026-07-25: Final runtime verification passed all four revised updater scenario processes after the independent-review fixes. Cleanup was rechecked: no updater Scenario Sandboxes remain, no Axe file was written into updater packaging inputs, and the final diff check passes. Ticket criteria are complete and ready for maintainer triage.
- 2026-07-25: A final focus-transition review found that recovery hid the alert while leaving focus inside it. The renderer now detects that condition and moves focus to the visible status heading. The recovery fixture delivers failure then recovery through production IPC after observing failure focus, and the scenario asserts “Restoring Previous Installation” receives focus by accessible name. Static checks pass; runtime criteria are reopened pending the focused Electron rerun.
- 2026-07-25: Final focused verification passed all four updater processes with the failure-to-recovery focus transition. Cleanup and diff validation pass: no updater Scenario Sandboxes remain, updater packaging inputs are untouched, and the ticket is complete for maintainer triage.
