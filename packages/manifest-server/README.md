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
