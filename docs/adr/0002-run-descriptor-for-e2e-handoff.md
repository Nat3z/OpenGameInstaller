# Pass one run descriptor through the updater-to-application handoff

The E2E harness will provide one validated JSON Run Descriptor through a single explicit environment reference, which the updater forwards to the application it launches. This preserves the real updater handoff while giving both executables consistent sandbox paths, fixture endpoints, and automation connection details, avoiding an expanding collection of unrelated environment variables and command-line flags.
