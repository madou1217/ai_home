# Streaming WebUI assets checkpoint — 2026-11-15

## Source scope

Only `internal/transport/http/webuiassets/handler.go` plus this record. The existing pending migration changed full-file reads to streaming seekable files and introduced a bounded 4,096-entry digest cache, conditional responses, and range support. Review found two correctness gaps before that source was committed:

1. Ordinary GET/HEAD bypassed the standard condition evaluator. An actual isolated Go Server returned 200 for mismatched `If-Match` and stale `If-Unmodified-Since`, while adding Range to the same mismatched `If-Match` returned 412.
2. For nonseekable `fs.File`, a cold request received an in-memory seeker but an ETag-cache hit returned only the original nonseekable file, changing Range behavior between requests.

## Correction

Use one `http.ServeContent` path for GET/HEAD, conditional requests, and ranges. Seekable files retain streaming output; the bounded cache stores only size, modification time, and digest. Nonseekable files do not use that metadata-only fast path and always provide a seekable reader for the response; their content is not retained in the handler cache. The redundant hand-written ETag matcher was removed.

Comments no longer claim guaranteed sendfile or that `os.DirFS` confines symlinks. Deployment still must supply a trusted static tree. No filesystem-security claim is inferred from path normalization alone.

## Fresh actual verification

Built an isolated native Go Server from an exported committed snapshot plus the exact source closure. Ran it on an ephemeral loopback port with empty temporary HOME/state, distinct generated keys, and the repository's actual `web/dist` (267,559-byte JS artifact verified byte-for-byte). No mock HTTP handler or new test file was used.

- Before correction: mismatched `If-Match` without Range 200; stale `If-Unmodified-Since` 200; the same mismatched `If-Match` with Range 412.
- After correction, 12 requests repeated across the first-to-warm and warm cache phases (24 total): ordinary GET 200; matching strong `If-Match` 200; mismatched/weak `If-Match` 412; stale `If-Unmodified-Since` 412; weak/star `If-None-Match` 304; byte range 206 with exact requested bytes; mismatched `If-Range` 200 with the full original body; HEAD 200 without body and mismatched-condition HEAD 412.
- Previous actual asset run also verified SPA fallback, missing JS 404, query-preserving `/ui` redirect, digest equality, immutable cache headers, and HEAD length.
- Package/server builds and `go vet` on the production source passed. The isolated server shut down with exit 0; no shared service restart or deployment occurred.

## Review and remaining evidence

Archimedes's resumed read-only review identified the condition/nonseek inconsistencies, but its context exhausted before final review. The owner completed source review and actual before/after verification using the repository's documented `self_review` fallback; no independent final approval is claimed. Existing shared test files were neither modified nor staged.

The production `os.DirFS` seekable path was actually executed; the nonseekable branch correction is source-reviewed only. Nonseekable materialization is not a global memory bound. Same-size/same-mtime in-place file changes, Windows/browser execution, comprehensive cache contention/performance, and a full release are not certified. The overall Node-to-Go goal remains active.
