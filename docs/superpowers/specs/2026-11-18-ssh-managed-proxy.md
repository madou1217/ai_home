# SSH managed proxy and automatic reverse tunnels

## User-approved intent
SSH hosts expose separate reverse-tunnel and proxy-export switches. Reverse ports are allocated atomically by sshd, never guessed or stolen. Enabling a host as a proxy automatically registers its stable SSH-origin node in the existing proxy pool. Provider/harness install and update consume that pool with optional `--proxy` and available-node TAB completion. No temporary operator scripts or remote proxy software.

## Ownership and interfaces
- SSH record: `reverseTunnel: { enabled: true, remotePort?: number, localPort?: number } | null`; old nonzero ports remain readable. UI writes auto mode without port. `proxyEnabled: boolean` is independent from per-host `egressConnectionId`.
- Reverse supervisor/status exposes the actual bound remote port. Automatic reconnect may allocate a new port; consumers use runtime status, not stale configuration. Failure is confined to one connection.
- New Go `internal/runtime/sshproxy` owns authenticated loopback HTTP listeners forwarding by SSH direct-tcpip. Stable selector `ssh:<connectionId>`. No remote commands/install, no public listener, host-key checks preserved. Reconnect/backoff/disable/delete/lifetime are owned by the server, not CLI.
- Existing proxy-pool store receives managed source/node projections under lock; SSH credentials never enter the pool. Node identity is tied to SSH connection, not allocated port. Only provenance-verified runtime endpoints bypass ordinary loopback rejection; other nodes keep existing security rules.
- Shared management API `GET /v1/management/proxy-candidates` returns `{ok,candidates:[{id,name,source,available,error?}]}` without secrets, no dialing on completion. `POST /v1/management/proxy-leases` accepts `{selector}` (`auto`, `ssh:...`, node ID, or pool) and returns `{ok,id,proxyUrl,name}`. `DELETE .../{id}` releases. Authenticated GET upgrade endpoint `.../{id}/connect` tunnels a client-side loopback HTTP proxy to the server without returning an unusable server localhost URL to a remote CLI. Lease expiry handles abnormal termination.
- CLI keeps direct URL support; `--proxy` without value chooses auto; named selectors resolve through management API. `install` uses existing install lifecycle, `update` preserves channel ownership. Local task ingress/listener is random, authenticated, and disposed on completion/cancel.
- Existing enabled, routable HTTP(S)/SOCKS nodes are compatible direct candidates; the existing running pool is exposed without changing its selected global node. SSH-origin nodes appear in the same resource catalog and provide an HTTP interface suitable for npm/curl/native updaters.
- Completion reads a bounded management API snapshot only at proxy value position, no connections or writes, preserving native `--` escape.

## Acceptance
Real AWS native SSH handshake and proxied official HTTPS request; reverse ephemeral allocation with duplicate enabled hosts; no non-task listeners killed; SSH switch persists and creates/removes pool source; readiness/cancellation/reconnect; actual provider install/update via auto and selector; actual `__complete` output; desktop Microsoft Edge background visual inspection if available. No new test cases, no mobile feature work, no branches/worktrees, no unrelated resets/staging/commits.
