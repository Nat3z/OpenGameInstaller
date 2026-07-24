# 02 — Make the updater automation-accessible

**What to build:** Make the complete updater UI usable by assistive technology and stable user-level automation. Its channel selection, progress, failure, recovery, and status surfaces should be discoverable without DOM-structure or styling selectors.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Updater controls and status regions expose correct roles, accessible names, values, and states.
- [ ] Channel selection, progress, error, and recovery presentation are included.
- [ ] Stable test IDs exist only where accessible semantics remain ambiguous.
- [ ] An automated updater accessibility scan passes and is capable of blocking regressions.
- [ ] Any unavoidable exception records its justification and owner.
