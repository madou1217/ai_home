# 2026-06-26 Real Japan VPS Deploy

## Scope

按用户提供的两台日本 VPS 做真实 Fabric server 部署验证，不使用 mock 数据，不生成 fake registry。验证链路包括：当前账号配置导出、Node runtime 随包上传、源码/Web dist 上传、远端依赖安装、远端真实账号导入、临时 server 启动、远端本机 `/healthz` / `/v0/fabric/descriptor` / `/ui/` 验证。

本轮未改 systemd、未安装系统包、未改防火墙、未删除远端目录。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Local Node: `v22.16.0`
- Accounts export: `tmp/fabric-real-deploy/aih-accounts-real.zip`
- VPS 1: `ubuntu@155.248.183.169`
  - OS: Ubuntu 24.04.3 LTS
  - Kernel: `6.17.0-1014-oracle`
  - Arch: `x86_64`
  - glibc: `2.39`
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-0014`
  - Runtime archive: `node-v22.16.0-linux-x64.tar.xz`
  - Server PID: `315291`
- VPS 2: `opc@152.70.105.41`
  - OS: CentOS Linux 7
  - Kernel: `3.10.0-1160.25.1.el7.x86_64`
  - Arch: `x86_64`
  - glibc: `2.17`
  - Remote dir: `/home/opc/aih-fabric-real-20260627-0030`
  - Runtime archive: `node-v22.16.0-linux-x64-glibc-217.tar.xz`
  - Server PID: `963`

## Commands

```bash
node "bin/ai-home.js" export "tmp/fabric-real-deploy/aih-accounts-real.zip"
npm run web:build

curl -I -s "https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz"
curl -I -s "https://unofficial-builds.nodejs.org/download/release/v22.16.0/node-v22.16.0-linux-x64-glibc-217.tar.xz"
curl -L -s "https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz" -o "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz"
curl -L -s "https://unofficial-builds.nodejs.org/download/release/v22.16.0/node-v22.16.0-linux-x64-glibc-217.tar.xz" -o "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64-glibc-217.tar.xz"

node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@155.248.183.169" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-0014" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 18080 \
  --skip-build

node "scripts/fabric-real-vps-deploy.js" \
  --ssh "opc@152.70.105.41" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real.zip" \
  --remote-dir "/home/opc/aih-fabric-real-20260627-0030" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64-glibc-217.tar.xz" \
  --port 18080 \
  --skip-build

ssh "ubuntu@155.248.183.169" "curl -s -o /tmp/aih-healthz.txt -w 'health code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/healthz"
ssh "ubuntu@155.248.183.169" "curl -s -o /tmp/aih-descriptor.json -w 'descriptor code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/v0/fabric/descriptor"
ssh "ubuntu@155.248.183.169" "curl -s -o /tmp/aih-ui.html -w 'ui code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/ui/"

ssh "opc@152.70.105.41" "curl -s -o /tmp/aih-healthz.txt -w 'health code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/healthz"
ssh "opc@152.70.105.41" "curl -s -o /tmp/aih-descriptor.json -w 'descriptor code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/v0/fabric/descriptor"
ssh "opc@152.70.105.41" "curl -s -o /tmp/aih-ui.html -w 'ui code=%{http_code} time=%{time_total} size=%{size_download}\n' --max-time 8 http://127.0.0.1:18080/ui/"

curl -x "" --max-time 10 "http://155.248.183.169:18080/healthz"
curl -x "" --max-time 10 "http://152.70.105.41:18080/healthz"
```

## Metrics

| metric | value | note |
|---|---:|---|
| local accounts export | 15 imported-capable accounts | `agy, claude, codex, gemini`; 2 skipped |
| accounts zip sha256 | `14b8f3dd4745dc3ae1f6d3bd65aa3e7f604042a7a7c578abe1148f69e3c48bd2` | local, `155`, `152` match |
| official Node runtime sha256 | `f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e` | local and `155` match |
| glibc-217 Node runtime sha256 | `b9989f629d719a08fe69f7e333cc31d1be2d8388e3277968a2beae437c8d6e7b` | local and `152` match |
| local web build | pass | Vite built in 5.33s |
| `155` remote npm install | pass | `npm install --ignore-scripts`, 30 packages, 12s |
| `152` remote npm install | pass | `npm install --ignore-scripts`, 30 packages, 10s |
| `155` remote import | pass | imported=15, duplicates=0, invalid=0, failed=0 |
| `152` remote import | pass | imported=15, duplicates=0, invalid=0, failed=0 |
| `155` localhost health | HTTP 200 | `size=43`, `time=0.008286` |
| `155` localhost descriptor | HTTP 200 | `size=2355`, `time=0.005182` |
| `155` localhost UI | HTTP 200 | `size=1189`, `time=0.004154` |
| `152` localhost health | HTTP 200 | `size=43`, `time=0.013` |
| `152` localhost descriptor | HTTP 200 | `size=2355`, `time=0.004` |
| `152` localhost UI | HTTP 200 | `size=1189`, `time=0.003` |
| local direct public 18080 | inconclusive | local network reports TCP success even for random unopened `59999` ports |
| `155 -> 152:18080` | fail | `No route to host` |
| `152 -> 155:18080` | fail | connection timed out after 6s |

## Results

### `ubuntu@155.248.183.169`

Runtime and import completed:

```text
v22.16.0
10.9.2
added 30 packages, and audited 31 packages in 12s
zip: source=/home/ubuntu/aih-fabric-real-20260627-0014/aih-accounts-real.zip imported=15 duplicates=0 invalid=0 failed=0
```

Server started:

```text
315291
server serve started
listen: http://0.0.0.0:18080
accounts: codex=3, gemini=0, claude=4, agy=0, opencode=0
```

Remote localhost verification:

```text
health code=200 time=0.008286 size=43
descriptor code=200 time=0.005182 size=2355
ui code=200 time=0.004154 size=1189
```

### `opc@152.70.105.41`

Runtime and import completed:

```text
v22.16.0
10.9.2
added 30 packages, and audited 31 packages in 10s
zip: source=/home/opc/aih-fabric-real-20260627-0030/aih-accounts-real.zip imported=15 duplicates=0 invalid=0 failed=0
```

Server started:

```text
963
server serve started
listen: http://0.0.0.0:18080
accounts: codex=3, gemini=0, claude=4, agy=0, opencode=0
```

Remote localhost verification:

```text
health code=200 time=0.013 size=43
descriptor code=200 time=0.004 size=2355
ui code=200 time=0.003 size=1189
```

### Public Ingress

Remote process is not the blocker: both servers listen on `0.0.0.0:18080` and respond on remote localhost.

Public ingress is blocked or intercepted:

- `155 -> 152:18080`: `No route to host`.
- `152 -> 155:18080`: connection timed out.
- `155` UFW is active and allows `20,21,22,80,443,888,8888,23506,39000:40000,11111,9000`; `18080` is not allowed.
- `152` firewalld public zone allows `11111,20,21,22,80,443,27053,39000-40000,8888,3333,9100,9000`; `18080` is not allowed.
- Local direct TCP checks from this machine are not reliable evidence because even random unopened `59999` reported TCP success.

## Implementation Adjustments

- `scripts/fabric-real-vps-deploy.js` now supports `--node-runtime <tar.xz>` and runs Node from `.node-runtime/...` under the remote deploy dir.
- Source archive now uses `--format ustar --no-xattrs` to avoid macOS PAX/xattr stderr amplification on weak links.
- `lib/cli/app.js` and `lib/server/web-account-auth.js` lazy-load `node-pty`, so `npm install --ignore-scripts` can start server paths that do not need native PTY.

## Interpretation

- The two Japan VPS deployments are real: current account export was imported remotely; remote server processes are running; Fabric descriptor and Web UI are reachable on remote localhost.
- This is not yet a public client-ready server because public ingress to `18080` is blocked by host/cloud firewall policy.
- We should not silently open firewall or install persistent services. The next step needs an explicit operator decision: either allow a chosen port, bind AIH behind an existing reverse proxy/TLS endpoint, or use outbound relay/SSH tunnel as the default no-public-ingress path.
- For 2M-3M weak servers, full source + runtime upload works but is slow. Production-grade flow should cache runtime once and use incremental source artifact upload or release tarballs.

## Verdict

partial

Deployment/import/server-local verification passed on both Japan VPS. Public ingress verification failed due network/firewall path, not due AIH server startup.

## Next Checks

1. Decide ingress strategy for real clients:
   - open a chosen AIH port explicitly,
   - reuse an existing HTTPS reverse proxy,
   - or make outbound relay the default path.
2. Run real `aih fabric registry publish` from actual home/company nodes against a reachable server endpoint.
3. Add a node heartbeat/daemon flow; current publisher is still one-shot.
4. Optimize deploy artifacts: runtime cache, source delta, and no remote Web build.
5. Fix `aih claude -p` worker boot reliability before assigning complex Fabric frontend work to Claude.
