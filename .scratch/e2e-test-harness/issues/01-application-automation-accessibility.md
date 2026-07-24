# 01 — Make the application automation-accessible

**What to build:** Make the complete application UI usable by assistive technology and stable user-level automation. Every interactive surface should expose meaningful semantics, and an automated scan should demonstrate that the application is ready for later Application Scenarios.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] Native and custom controls expose correct roles, accessible names, values, and states.
- [x] Icon-only controls, navigation, inputs, dropdowns, dialogs, progress UI, and dynamic status regions are covered.
- [x] Stable test IDs exist only where accessible semantics cannot uniquely identify an element.
- [x] An automated application accessibility scan passes and is capable of blocking regressions.
- [x] Any unavoidable exception records its justification and owner.

## Comments

- 2026-07-24: Initial WIP harness typechecks and repository lint passes. The Electron accessibility scenario builds and starts under Xvfb, but its first worker times out; acceptance criteria remain unchecked for handoff.
- 2026-07-24: Completed the semantic UI audit and the sandboxed Electron/Axe scan. Welcome, resumed setup, and main-application states pass, and the scan runs as a Linux/Windows pull-request gate.
