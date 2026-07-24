# Preserve the last known-good installation during updates

The updater must download, stage, and verify a complete candidate without mutating the Last Known-Good Installation, then replace it through a recoverable backup. The prior installation remains restorable until the replacement emits a bounded Startup Health Signal after required startup work and its main or first-run UI is ready; if replacement, startup, or the handshake fails, the updater restores it so an update failure cannot strand the user without a working application.
