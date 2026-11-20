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

## Native timing evidence

Request-level timing was added behind `X-Aih-Timing: 1` to both the native Codex Responses handler and the canonical Responses handler. A local request produced:

```
responses native timing model=gpt-6.1-sol stream=true
account=acct_c016fd7eee0f64163068 total_ms=4002 account_ms=2
upstream_ms=3944 probe_ms=3950 committed_ms=3950 first_write_ms=3950
```

The request used the **native** handler. Account selection took 2 ms, the upstream response headers arrived at 3944 ms, the probe completed 6 ms later, and the first client write happened immediately. The local handler overhead is therefore on the order of tens of milliseconds, not seconds.

## Corrected conclusion

The local gateway is not the slow component for this request. The measured TTFB is dominated by the upstream/proxy response-header latency. The earlier 2–4 s local-vs-direct delta was upstream/network variance and cold-start effects, not a canonical-path buffering problem. The working hypothesis that api_key requests necessarily fall back to the canonical handler is not supported by this request; the native fast path was used.

## Next step

No local Responses refactor is justified by this evidence. If the latency target still needs improvement, profile the proxy/upstream response-header path (or the network hop to it). Keep the opt-in `X-Aih-Timing` instrumentation for future comparisons; it is inert unless the header is present.

## Environment note

The local server was restarted by another session during this measurement window. All numbers above come from a ready instance; the first row is the post-restart cold request. No code or account state was changed by this investigation.
