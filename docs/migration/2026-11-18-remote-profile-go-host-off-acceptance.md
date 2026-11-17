# R6: remote profile routing through the Go host

Accepted on 2026-11-18 at 03:19 Asia/Shanghai. This checkpoint replaces the
public Go host's remote WebUI forwarding dependency on the first-party Node
front door with the existing Go `webuicontrolplaneapi.RemoteProxy`.

This acceptance covers the R6 routing slice. Default startup still requires
separate domain acceptance before the overall Node exit can be declared.
No shared service, AWS installation, real profile, or shared database was
changed during this acceptance.

## Source and artifact

The verified source is committed base
`bf992b3c20ab75ef44cc8fb0573d445eec7dec1e` plus the four source overlays below.
The committed artifact is the source change; the private binary is evidence,
not an installed release.

| Path | Resulting Git blob |
| --- | --- |
| `internal/host/aihserver/remote_webui_proxy.go` | `f096a941aebd0939b1365d5f51700a6a8ea10819` |
| `internal/host/aihserver/composition.go` | `da02559785dc6cc21c06816a613c1b25cabd9c6b` |
| `internal/host/aihserver/router.go` | `e61bd3e71a3b55edeb42c4ae21f9aef8123f1ae6` |
| `internal/transport/http/webuicontrolplaneapi/remote_proxy.go` | `567c40cbca61675c39ccfd25ba8779db6b65afe9` |

Private binary SHA-256:
`fdcb89ea899d20ad3dd5ffd277e20bd9c64917f84a09cbc4c3179659d1e57a0b`.
The composition overlay contains only the R6 field, construction, and
assignment. Concurrent ContextWindows and AliasPool edits are excluded.
The router preserves the preceding R7 browser terminal registrations.

## Behavior

- Remote `/v0/webui` requests enter the existing Go proxy after authenticating
  the caller with the local management key. Profile resolution and remote
  Bearer substitution follow authentication.
- A valid target header takes precedence over a valid query target. Encoded
  and mixed-case query names are recognized; target headers and query fields
  are removed before forwarding.
- A malformed query returns `400 server_proxy_invalid_query`, including when
  a valid target header is present. Without valid local credentials it first
  returns 401. Malformed query data cannot select the local data handler.
- A missing or invalid target returns 404; an offline target returns 502;
  a hop-limit violation returns 508; a wrong remote key returns the upstream
  401. These cases do not fall back to local business data.
- Self-target matching uses the accepted socket from `http.LocalAddrContextKey`
  and actual TLS state. Host and forwarded headers cannot prove a self target.
- Existing always-local profile, bootstrap, and internal callback paths retain
  their local handlers and authentication contracts.
- The existing reverse proxy carries HTTP streams and the existing header-
  authorized WebSocket contract. Browser remote watches already use authorized
  SSE; no browser WebSocket authentication protocol was added.

## Actual execution evidence

No test files were added. Two real private `aih-server` processes were built
and started without front-door or Node-supervision flags, with isolated homes,
empty private stores, random ephemeral keys, and no Node executable on PATH.
Only loopback endpoints were used. The services reported different server
config ports, allowing each request to prove local versus remote execution.

Before the transport corrections, actual requests demonstrated:

| Input | Incorrect observed result |
| --- | --- |
| Percent-encoded target name `%78-aih-server-id` | 200 with the local port 57302 |
| Profile endpoint `http://:9` | 200 with the local port 57302 |
| Remote target with forged `X-Forwarded-Host` or `Host` | 200 with local port 58768 rather than remote port 58774 |
| Target query with `%ZZ` or an unescaped semicolon | 200 with local port 58768 |

After correction, all 34 real checks passed. Local PID 54643 listened on
59209; remote PID 54655 listened on 59219. Checks covered local behavior,
header/query/encoded/mixed-case targets, precedence, invalid profiles, a valid
self profile, forged Host/forwarded headers, malformed queries, authentication
ordering, loops, offline targets, wrong and restored remote credentials,
always-local profiles, upstream 404, SSE and WebSocket traffic, and process
samples.

The actual `/v0/webui/accounts/watch` SSE returned `connected` then `snapshot`
in 18 ms. The remote established TCP connection disappeared 15 ms after
client cancellation. The actual `/v0/webui/sessions/watch/ws` upgraded with
101 and returned `connected`; its remote TCP connection disappeared 16 ms
after cancellation. Native watch WebSocket first-frame authentication retained
the existing remote-key contract.

Both process-tree samples contained only the two private Go services, with no
Node child. Both private services were terminated and exited with code 0 after
acceptance. These samples establish this slice's execution boundary; they do
not prove every other host domain is Node-free.

Commands run against the fixed candidate, both exit 0:

```sh
go build -o <private-evidence>/r6-reviewed-candidate-server ./cmd/aih-server
go vet ./internal/host/aihserver ./internal/transport/http/webuicontrolplaneapi
```

An independent read-only review first identified the self-origin and malformed-
query defects. The corrected fixed candidate was reviewed again; both issues
were confirmed closed with no remaining blocking finding for these four files.
The review was source review; the execution evidence above comes from the
real private services.

## Evidence location and remaining integration boundary

Local evidence root:
`/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-node-exit-handoff-20261118-n8cu8cd5`.
This temporary location is not a durable release artifact. This document
preserves the source hashes, executable hash, results, and scope in the repo.

Relevant files beneath that root:

- `r6-before-transport-live/acceptance.json`: encoded-target and invalid-origin failures.
- `r6-review-before-live/acceptance.json`: forged Host and malformed-query reproductions.
- `r6-reviewed-candidate-info.json`: exact verified source overlays.
- `r6-reviewed-build.json` and `r6-reviewed-vet.json`: command output and exits.
- `r6-reviewed-live/acceptance.json`: all 34 successful checks and process cleanup.
- `r6-review-hardening-authorization.json`: supervisor approval for the review corrections.

No public or AWS runtime was restarted to load this source. Credential refresh,
host credential observation, usage read models, deletion writer ownership,
relay sockets, first-party plugin hosting, and run ownership remain separate
Node-exit gates under the migration supervisor. Installation and default
startup topology must follow those domain gates.
