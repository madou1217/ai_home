# 2026-06-26 Real VPS Refresh And Claude Worker

## Scope

复核真实 Fabric VPS 部署状态、`39.104.59.31` 当前可管理性、`aih claude` worker 可用性，以及本地全量回归测试。

本轮不使用 mock registry，不生成假数据，不改 systemd，不安装系统包，不改防火墙，不删除远端目录。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Local Node: `v22.16.0`
- Accounts export: `tmp/fabric-real-deploy/aih-accounts-real.zip`
- Accounts export sha256: `14b8f3dd4745dc3ae1f6d3bd65aa3e7f604042a7a7c578abe1148f69e3c48bd2`
- Official Node runtime sha256: `f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e`
- glibc-217 Node runtime sha256: `b9989f629d719a08fe69f7e333cc31d1be2d8388e3277968a2beae437c8d6e7b`
- Japan VPS 1: `ubuntu@155.248.183.169`
- Japan VPS 2: `opc@152.70.105.41`
- Weak VPS: `root@39.104.59.31`
- Claude account tested: `claude#4`

## Commands

```bash
find "tmp/fabric-real-deploy" -maxdepth 4 -type f -print -exec shasum -a 256 {} \;

ssh -o BatchMode=yes -o ConnectTimeout=20 "ubuntu@155.248.183.169" \
  "echo ssh-ok; curl -s -o /tmp/aih-healthz-check.txt -w 'health code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/healthz; curl -s -o /tmp/aih-descriptor-check.json -w 'descriptor code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/v0/fabric/descriptor"

ssh -o BatchMode=yes -o ConnectTimeout=20 "opc@152.70.105.41" \
  "echo ssh-ok; curl -s -o /tmp/aih-healthz-check.txt -w 'health code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/healthz; curl -s -o /tmp/aih-descriptor-check.json -w 'descriptor code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/v0/fabric/descriptor"

ssh -o BatchMode=yes -o ConnectTimeout=20 "root@39.104.59.31" \
  "echo ssh-ok; hostname; uname -a"

nc -vz -w 8 "39.104.59.31" 22
node "bin/ai-home.js" fabric transport probe "tcp://39.104.59.31:22" "tcp://39.104.59.31:8317" "tcp://39.104.59.31:9527" --timeout-ms 8000 --json
ssh -vv -o BatchMode=yes -o ConnectTimeout=60 -o ServerAliveInterval=10 -o ServerAliveCountMax=1 "root@39.104.59.31" "echo ssh-ok; uptime"

env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY \
  CLAUDE_CONFIG_DIR="/Users/model/.ai_home/profiles/claude/4/.claude" \
  claude -p "只输出 ok"

env AIH_NO_PERSIST=1 AIH_RUNTIME_SHOW_USAGE=0 \
  node "bin/ai-home.js" claude 4 -p "只输出 ok"

env AIH_NO_PERSIST=1 AIH_RUNTIME_SHOW_USAGE=0 \
  node "bin/ai-home.js" claude 4 -p "<Fabric frontend review prompt>"

node --test "test/pty-runtime.test.js"
node --test "test/web-account-auth.test.js" "test/fabric-real-vps-deploy.test.js"
node --test "test/fabric-*.test.js" "test/server-node-rpc-wiring.test.js"
node --test "test/provider-launch-strategy.test.js"
npm test
```

## Metrics

| metric | value | note |
|---|---:|---|
| `155` SSH command | pass | `ssh-ok` |
| `155` localhost health | HTTP 200 | `time=0.003111`, `size=43` |
| `155` localhost descriptor | HTTP 200 | `time=0.002864`, `size=2357` |
| `152` SSH command | pass | `ssh-ok` |
| `152` localhost health | HTTP 200 | `time=0.001`, `size=43` |
| `152` localhost descriptor | HTTP 200 | `time=0.002`, `size=2357` |
| `39` TCP 22 | reachable | `nc` and `fabric transport probe` both reachable |
| `39` TCP 8317/9527 | reachable | TCP connect only; not service health |
| `39` SSH command | fail | `Connection timed out during banner exchange` |
| native `claude -p` isolated env | pass | output `ok` |
| `aih claude 4 -p` smoke | pass | output `ok` |
| `aih claude 4 -p` frontend review | pass, slow first token | completed after about 90s |
| `node --test test/pty-runtime.test.js` | pass | 118/118 |
| `node --test test/web-account-auth.test.js test/fabric-real-vps-deploy.test.js` | pass | 50/50 |
| `node --test test/fabric-*.test.js test/server-node-rpc-wiring.test.js` | pass | 44/44 |
| `node --test test/provider-launch-strategy.test.js` | pass | 27/27 |
| `npm test` | pass | 2417/2417 |

## Results

### Japan VPS Refresh

`ubuntu@155.248.183.169`:

```text
ssh-ok
health code=200 time=0.003111 size=43
descriptor code=200 time=0.002864 size=2357
```

`opc@152.70.105.41`:

```text
ssh-ok
health code=200 time=0.001 size=43
descriptor code=200 time=0.002 size=2357
```

### `39.104.59.31`

TCP connect is not enough:

```text
Connection to 39.104.59.31 port 22 [tcp/ssh] succeeded!
```

Structured probe also sees TCP reachable:

```json
{
  "ok": true,
  "probes": [
    { "target": "tcp://39.104.59.31:22", "reachable": true, "status": "reachable" },
    { "target": "tcp://39.104.59.31:8317", "reachable": true, "status": "reachable" },
    { "target": "tcp://39.104.59.31:9527", "reachable": true, "status": "reachable" }
  ]
}
```

But SSH management is not usable:

```text
debug1: Connection established.
debug1: Local version string SSH-2.0-OpenSSH_10.3
Connection timed out during banner exchange
Connection to 39.104.59.31 port 22 timed out
```

### Claude Worker

Direct native Claude with isolated account env works:

```text
ok
```

`aih claude 4 -p` also works for a minimal non-interactive prompt:

```text
[aih] Running claude (Account ID: 4) via PTY Sandbox
[aih] Session links ready (claude): migrated 0, linked 30.
ok
```

Inherited shell pollution was confirmed separately: when `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` are not removed, native Claude warns that env auth takes precedence over claude.ai login and can hit the wrong upstream. The `aih claude 4 -p` path avoided that in the successful smoke.

Claude frontend review completed and found three real issues:

1. `FabricWebrtcLab.tsx` uses log text as React key, so duplicate log lines in the same second can be reused or lost.
2. WebRTC Lab share URL uses `window.location.origin` instead of the configured signal endpoint, so cross-device joins can poll a different signaling server.
3. Server Setup does not implement the wireframe-required probe result matrix or enforce successful probe before saving an active server.

## Interpretation

- The two Japan VPS deployments are still alive and serving Fabric endpoints locally.
- `39.104.59.31` is currently not manageable over SSH despite TCP 22 being reachable. Do not deploy or claim success there until the SSH banner path recovers.
- `aih claude 4 -p` is usable, but complex frontend review has slow first token behavior. Future frontend work can be assigned to Claude, but evidence must include the exact `aih claude` command and output.
- Full local regression is green after the PTY test fixture correction.

## Verdict

partial

Japan VPS server-local verification and Claude worker smoke passed. Public ingress, `39.104.59.31` deployment, cross-device pairing, and real node registry publish remain unfinished.

## Next Checks

1. Pick an ingress strategy for `155` / `152`: explicit firewall/cloud ingress approval, existing HTTPS reverse proxy, or outbound relay/SSH tunnel.
2. When `39.104.59.31` SSH banner recovers, deploy using `scripts/fabric-real-vps-deploy.js` with local web build and bundled Node runtime; do not run remote Vite build.
3. Let `aih claude` implement the three Fabric frontend issues it found, then run `npm run web:build`, targeted web tests, and Playwright smoke.
4. Run real `aih fabric registry publish` from actual nodes after a reachable server endpoint exists.
