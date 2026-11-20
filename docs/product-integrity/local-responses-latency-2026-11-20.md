# Local Responses latency measurement

## Scope

The open ledger item "可'成功也慢'的本地延迟要查清" was reproduced with a successful, minimal Codex Responses request. The goal was to separate upstream latency from local gateway overhead before changing code.

## Method

The same request body was sent to the local gateway and directly to the AWS proxy:

```json
{"model":"gpt-6.1-sol","instructions":"You are a helpful assistant.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply with exactly OK."}]}],"stream":true,"store":false}
```

- Local: `http://127.0.0.1:9527/v1/responses` with the local client key.
- Direct: `https://proxy.meadeo.com/v1/responses` with the proxy account api key.
- Both used `curl -N`; timings are `time_starttransfer` / `time_total`.

## Results

| Run | Local TTFB | Local total | Proxy TTFB | Proxy total |
| --- | ---: | ---: | ---: | ---: |
| cold / first | 8.15s | 11.24s | - | - |
| 1 | 3.18s | 3.29s | 3.33s | 4.66s |
| 2 | 5.99s | 6.04s | 3.01s | 3.17s |
| 3 | 6.40s | 6.43s | 2.82s | 2.92s |
| header check | 4.00s | 6.14s | - | - |

The local response carries the proxy's headers (`Server: cloudflare`, `X-Aih-Server-Provider: codex`, `X-Codex-*`), so the upstream request itself is healthy. Warm local TTFB is roughly 2.1s above the direct proxy path on average, with runs varying between parity and +3.1s. The first request after a server restart was materially colder.

## Working hypothesis

The account used for this path is an `api_key` account whose base URL is the AWS aih proxy. The native Codex Responses HTTP fast path opens only for a resolved native Codex protocol route; an api_key upstream falls back to the canonical OpenAI Responses handler. The canonical path decodes and renders the stream and does not apply the native path's 1s pre-header probe/early delivery. The 1s probe itself is not enough to explain the full local delta; the remaining variance needs server-side timing.

## Next step

Before changing behavior, add request-scoped timing at the local Responses handler boundaries (account selection, upstream request start, upstream first header, first decoded event, first client flush). Then choose one of:

1. A generic raw-stream passthrough for same-protocol OpenAI Responses requests to OpenAI-compatible api_key upstreams, preserving the existing pre-commit failover rules.
2. Reduce canonical pre-commit buffering so the first upstream event is written without waiting for a later canonical event.

Both options change the commit/failover boundary and need explicit acceptance; neither should be inferred from the proxy's 2.8–3.5s header latency alone.

## Environment note

The local server was restarted by another session during this measurement window. All numbers above come from a ready instance; the first row is the post-restart cold request. No code or account state was changed by this investigation.
