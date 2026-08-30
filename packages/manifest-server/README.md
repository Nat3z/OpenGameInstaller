# @ogi-sdk/manifest-server

Community update-manifest server for OpenGameInstaller's managed game-update
system. Clients fetch a stored manifest by its source-set key and submit new
ones; the first submission for a key wins and is never overwritten.

## Endpoints

| Method | Path                        | Behavior                                                                       |
| ------ | --------------------------- | ------------------------------------------------------------------------------ |
| `GET`  | `/healthz`                  | `200 {"status":"ok"}`                                                          |
| `GET`  | `/v1/manifests/{key}`       | `200 {"manifest": ...}`, `404` when absent, `400` for a malformed key           |
| `POST` | `/v1/manifests`             | `201` stored, `200` identical re-submission, `409` conflict, `400`/`413`/`422` |

`POST` bodies may be plain JSON or gzipped with `Content-Encoding: gzip`. The
storage key is taken from the manifest's own `sourceSetKey` field, and the
payload is re-encoded as canonical JSON before it is persisted. Bodies are
capped at 8 MiB both before and after decompression.

## Trust model

Submissions are anonymous and first-submit-wins, so a submitter who knows a
source set's public URL hashes can reserve its key with bogus metadata. The
server cannot verify entry contents — manifests identify sources only by URL
hash, so it has nothing to fetch. This is bounded client-side: the desktop app
verifies every stored manifest against the real remote archive's ZIP structure
and sha256-checks each extracted entry, so a poisoned manifest can at worst
force the full-download fallback — the same behavior as having no manifest at
all. Authenticated submission or moderation is a deliberate non-goal for v1.

## Environment

| Variable               | Default   | Notes                          |
| ---------------------- | --------- | ------------------------------ |
| `PORT`                 | `8619`    |                                |
| `MANIFEST_STORAGE`     | `local`   | `local` or `s3`                |
| `MANIFEST_DATA_DIR`    | `./data`  | local storage only             |
| `S3_ENDPOINT`          | —         | s3 only                        |
| `S3_BUCKET`            | —         | s3 only, required              |
| `S3_REGION`            | `auto`    | s3 only                        |
| `S3_ACCESS_KEY_ID`     | —         | s3 only, required              |
| `S3_SECRET_ACCESS_KEY` | —         | s3 only, required              |

## Commands

```sh
bun run dev        # watch mode
bun run start      # run the server
bun run build      # bundle to build/
bun run typecheck
bun test
```

The shared manifest schema is published on the `./schema` subpath and depends
only on `effect` and `node:crypto`, so Node consumers can import it without
pulling in the server.
