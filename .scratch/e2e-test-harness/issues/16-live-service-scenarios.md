# 16 — Add user-triggered Live Service Scenarios

**What to build:** Let a developer explicitly select and run real credentialed provider checks from CLI or the Observer Window while preventing accidental shared-CI execution or secret leakage.

**Blocked by:** 05 — Observe and control a live run; 07 — Deliver the Golden Journey; 12 — Enforce retries, outcomes, retention, and process hygiene

**Status:** ready-for-review

- [x] CLI and Observer expose a clearly separate Live Service Scenario selection.
- [x] Starting requires explicit confirmation and validates required credentials.
- [x] Credentials are never inherited automatically into shared required CI.
- [x] Events, logs, descriptors, reports, and screenshots redact secrets where feasible.
- [x] Live Service results report external integration health but do not replace deterministic coverage.
- [x] Live Service outcomes do not block normal PR or nightly suites.

## Comments

- Added a dedicated `e2e:live-service` CLI and separately selected Observer Window flow. CLI provider selection and confirmation must come from flags or the interactive gesture; an authenticated Observer command is translated into controlled child arguments. Credentials may come from the selected provider's environment variable only after that explicit choice.
- Deterministic children strip all `OGI_LIVE_*` variables. Real providers hard-refuse conventional active CI markers regardless of case or common truthy representation, while automated coverage uses only the literal-loopback synthetic provider and synthetic credentials.
- Centralized redaction covers Unicode normalization, URI/form encodings, form `+`, per-token mixed-case percent escapes, repeated percent encoding, malformed wrappers, padded/unpadded Base64 and Base64URL, hex, authorization/header embeddings, structured values, artifact names, credentialed URLs, and output split across stream chunks. An independent canonical percent decoder, deliberately separate from generated-variant enumeration, validates mixed-case, double-encoded, malformed-wrapped, form, split-chunk, and retained-artifact probes.
- Observer WebSocket upgrades require the exact allocated Observer Origin as well as the one-time/session authentication. Missing, null, cross-port, cross-host, and cross-scheme Origins are rejected; valid refresh and reconnect upgrades remain supported.
- Live cancellation aborts an active provider request through the Observer control file and emits typed `Cancelled` step, attempt, scenario, and run events before reports and pinned retention are finalized. Synthetic redirects use manual handling with bounded hops, exact literal-loopback origin/port/path containment, loop and credential rejection, and redacted redirect evidence.
- The immutable provider registry owns each real provider's endpoint, HTTP method, and redirect allowlist. The exported API forbids a GitHub endpoint at the TypeScript boundary with `endpoint?: never` and rejects runtime override attempts before any request. Real redirects are processed manually against the registered HTTPS allowlist, and Authorization is sent only to the registered credential origin; direct exfiltration and unregistered cross-origin redirect regressions verify that no credential reaches another endpoint.
- 2026-07-26: Final verification passed 265 E2E tests (2,281 assertions), E2E/Observer typecheck (`343 files`, `0 errors`, `0 warnings`), Observer production build and Axe scan, application/updater production builds and package-boundary scan (`activeHookMatches: []`), scoped Biome, actionlint 1.7.7, `git diff --check`, real-token-pattern scan, and process-leak scan. The post-suite retained-artifact scan checked 1,275 files against 448 generated variants plus independent canonical percent decoding. Windows runtime execution remains deferred under the ticket-group policy; no Windows runtime claim is made.
