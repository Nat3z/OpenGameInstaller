# Context Map

## Contexts

- [E2E Testing](./e2e/CONTEXT.md) — exercises and observes the updater and application as complete desktop products

## Relationships

- **E2E Testing → Updater**: supplies an E2E-only Run Descriptor and Fixture Service responses while driving the real updater UI and lifecycle
- **E2E Testing → Application**: drives user actions through the application UI and observes readiness and sandboxed external effects
- **Updater → Application**: installs and launches the application, retaining the Last Known-Good Installation until the application emits a Startup Health Signal
