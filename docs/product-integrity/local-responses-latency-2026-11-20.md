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

## AWS proxy timing

The same `X-Aih-Timing` header was used against the AWS proxy's own loopback endpoint:

```
total_ms=1165 account_ms=11 upstream_ms=582 probe_ms=1092 committed_ms=1093 first_write_ms=1093
total_ms=1613 account_ms=0  upstream_ms=1012 probe_ms=1574 committed_ms=1574 first_write_ms=1574
```

The proxy reaches its upstream response headers in 0.58–1.01s. The 1s probe then waits for the first body event and commits at 1.09–1.57s. Account selection is effectively zero.

## End-to-end breakdown

For the local request with TTFB ≈3.9s:

- account selection: ~2 ms;
- local handler/probe/first write: ~50 ms;
- AWS proxy upstream header + probe: 1.1–1.6s;
- Mac → AWS/Cloudflare hop: roughly 2.3s by subtraction.

The local gateway is therefore not the slow component. The remaining cost is the network hop plus the proxy's upstream header/probe window. The probe is deliberate: shortening it would reduce TTFB but commit to an account before an upstream error frame can be observed, weakening pre-commit failover.

## Next step

No local Responses refactor is justified by this evidence. If the latency target still needs improvement, the remaining levers are the network path to the proxy and the 1s probe trade-off, both separate design decisions. Keep the opt-in `X-Aih-Timing` instrumentation for future comparisons; it is inert unless the header is present.

## Environment note

The local server was restarted by another session during this measurement window. All numbers above come from a ready instance; the first row is the post-restart cold request. No code or account state was changed by this investigation.
