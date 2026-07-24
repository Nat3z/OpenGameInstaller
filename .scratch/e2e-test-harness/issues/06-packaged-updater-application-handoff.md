# 06 — Complete the packaged updater-to-application handoff

**What to build:** Demonstrate a packaged E2E updater replacing a synthetic old installation with the packaged current application, forwarding the Run Descriptor, reconnecting user-level automation to the launched app, and waiting for an explicit Startup Health Signal.

**Blocked by:** 04 — Run the first deterministic Updater Scenario

**Status:** ready-for-agent

- [ ] Windows and Linux builders produce synthetic old installations and packaged E2E updater/application artifacts.
- [ ] The updater obtains the current artifact from the Fixture Service and performs the real launch handoff.
- [ ] The Run Descriptor reference crosses the updater-to-application boundary without multiplying flags or environment variables.
- [ ] Automation reconnects to the updater-launched application.
- [ ] The application emits Startup Health only after required startup work and interactive main or first-run UI.
- [ ] The updater keeps the prior installation recoverable until the bounded health signal arrives.
- [ ] Ordinary production artifacts contain no active Run Descriptor or E2E hook path.
- [ ] A production packaging smoke check proves the production boundary.
