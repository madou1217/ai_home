# 2026-06-26 Real VPS Deploy Attempt

## Scope

按真实 VPS 做 Fabric 部署验证，不使用 mock registry 数据。目标是把当前 worktree 和本机账号导出包部署到用户提供的服务器，并验证 server profile / registry / UI 的真实链路。

本轮没有完成最终部署。原因不是端口不可达，而是远端 SSH banner 层在弱机 build 后失去响应；账号包已传输到 `39.104.59.31`，但尚未完成远端导入和本次版本 server 启动。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-26
- Remote candidates:
  - `opc@152.70.105.41`
  - `ubuntu@155.248.183.169`
  - `root@39.104.59.31`
- First deploy target: `root@39.104.59.31`
- Remote deploy dir: `/root/aih-fabric-real-20260626-215410`

## Commands

```bash
node "bin/ai-home.js" node bootstrap probe \
  --ssh "opc@152.70.105.41" \
  --ssh "ubuntu@155.248.183.169" \
  --ssh "root@39.104.59.31" \
  -j 3 --json

ssh -o BatchMode=yes -o ConnectTimeout=20 "opc@152.70.105.41" "printf 'ok '; uname -a; command -v node || true; command -v npm || true; command -v git || true"
ssh -o BatchMode=yes -o ConnectTimeout=20 "ubuntu@155.248.183.169" "printf 'ok '; uname -a; command -v node || true; command -v npm || true; command -v git || true"
ssh -o BatchMode=yes -o ConnectTimeout=20 "root@39.104.59.31" "printf 'ok '; uname -a; command -v node || true; node --version || true; command -v npm || true; npm --version || true; command -v git || true; git --version || true; df -h . | tail -1; free -m | head -2"

mkdir -p "tmp/fabric-real-deploy"
node "bin/ai-home.js" export "tmp/fabric-real-deploy/aih-accounts-real.zip"
shasum -a 256 "tmp/fabric-real-deploy/aih-accounts-real.zip"

ssh -o BatchMode=yes -o ConnectTimeout=10 "root@39.104.59.31" "mkdir -p /root/aih-fabric-real-20260626-215410"
tar --exclude=".git" --exclude="node_modules" --exclude="web/node_modules" --exclude="tmp" --exclude="output" --exclude="logs" --exclude="*.log" --exclude="*.db" --exclude="*.db-shm" --exclude="*.db-wal" -czf - . \
  | ssh -o BatchMode=yes -o ConnectTimeout=10 "root@39.104.59.31" "tar -xzf - -C /root/aih-fabric-real-20260626-215410"
scp -o BatchMode=yes -o ConnectTimeout=10 "tmp/fabric-real-deploy/aih-accounts-real.zip" "root@39.104.59.31:/root/aih-fabric-real-20260626-215410/aih-accounts-real.zip"

ssh -o BatchMode=yes -o ConnectTimeout=10 "root@39.104.59.31" "cd /root/aih-fabric-real-20260626-215410 && pwd && ls -la bin/ai-home.js package.json web/package.json aih-accounts-real.zip && sha256sum aih-accounts-real.zip && npm install"
ssh -o BatchMode=yes -o ConnectTimeout=10 "root@39.104.59.31" "cd /root/aih-fabric-real-20260626-215410 && npm run web:build"

nc -vz -w 8 "39.104.59.31" 22
nc -vz -w 8 "39.104.59.31" 9527
nc -vz -w 8 "39.104.59.31" 8317
node "bin/ai-home.js" fabric transport probe tcp://39.104.59.31:22 tcp://39.104.59.31:9527 tcp://152.70.105.41:22 tcp://155.248.183.169:22 --timeout-ms 8000 --json

curl -s -o /tmp/aih-9527-health.txt -w "code=%{http_code} time=%{time_total} size=%{size_download} err=%{errormsg}\n" --max-time 8 "http://39.104.59.31:9527/healthz"
curl -s -o /tmp/aih-9527-desc.txt -w "code=%{http_code} time=%{time_total} size=%{size_download} err=%{errormsg}\n" --max-time 8 "http://39.104.59.31:9527/v0/fabric/descriptor"
curl -s -o /tmp/aih-8317-health.txt -w "code=%{http_code} time=%{time_total} size=%{size_download} err=%{errormsg}\n" --max-time 8 "http://39.104.59.31:8317/healthz"

ssh -vv -o BatchMode=yes -o ConnectTimeout=60 -o ServerAliveInterval=10 -o ServerAliveCountMax=1 "root@39.104.59.31" "echo ssh-ok; uptime"

node --test "test/fabric-real-vps-deploy.test.js"
node --test test/fabric-*.test.js test/server-node-rpc-wiring.test.js
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "root@39.104.59.31" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real.zip" \
  --remote-dir "/root/aih-fabric-real-20260626-215410" \
  --port 18080 \
  --skip-build --skip-import --skip-start --dry-run

npm run web:build
```

## Metrics

| metric | value | note |
|---|---:|---|
| local exported accounts | 15 | `agy, claude, codex, gemini`; 2 skipped |
| export zip sha256 | `9ad393b02850a8c2623576588757b8ef59718c16aab71a744e152d351367c99f` | local and remote match |
| first usable SSH host before deploy | 1/3 | `39.104.59.31` |
| TCP 22 reachable | 3/3 | all three hosts accept TCP |
| `39.104.59.31` memory | 1676 MB total | 617 MB available before deploy |
| `39.104.59.31` disk | 8.3 GB free | `/dev/vda3`, 78% used |
| root npm install | pass | root deps + web deps installed |
| remote explicit web build | fail / interrupted | stalled after `3668 modules transformed` on weak VPS |
| SSH after remote build | fail | 60s banner exchange timeout |
| `39.104.59.31:9527/healthz` | HTTP 502 after 5s | empty body, not AIH healthz |
| `39.104.59.31:8317/healthz` | HTTP 502 after 5s | empty body, not AIH healthz |
| weak VPS deploy script test | pass | `node --test test/fabric-real-vps-deploy.test.js` |
| Fabric focused regression | pass | `node --test test/fabric-*.test.js test/server-node-rpc-wiring.test.js`, 41/41 |
| local web production build | pass | 3668 modules transformed; built in 5.54s |

## Results

### Remote Reachability

- `opc@152.70.105.41`: TCP 22 reachable, SSH command fails with `Connection timed out during banner exchange`.
- `ubuntu@155.248.183.169`: TCP 22 reachable, SSH command fails with `Connection timed out during banner exchange`.
- `root@39.104.59.31`: initially SSH reachable; `node v22.22.1`, `npm 10.9.4`, `git 2.39.5`.

### Export / Transfer

Local export completed:

```text
providers=agy, claude, codex, gemini accounts=15 files=15 skipped=2
Backup exported: /Users/model/projects/feature/ai_home/tmp/fabric-real-deploy/aih-accounts-real.zip
9ad393b02850a8c2623576588757b8ef59718c16aab71a744e152d351367c99f
```

Remote transfer completed:

```text
/root/aih-fabric-real-20260626-215410
bin/ai-home.js
package.json
web/package.json
aih-accounts-real.zip
9ad393b02850a8c2623576588757b8ef59718c16aab71a744e152d351367c99f  aih-accounts-real.zip
```

### Remote Install

Remote `npm install` completed. It installed root dependencies and web dependencies through postinstall. It reported npm audit warnings but exited 0.

Explicit remote `npm run web:build` started and reached:

```text
vite v6.4.2 building for production...
transforming...
3668 modules transformed.
```

After that, no further output was produced for several minutes. A parallel SSH process check timed out during banner exchange. The build was interrupted to avoid keeping the weak VPS saturated.

### HTTP / Port State After Build Interruption

TCP still accepts connections:

```text
39.104.59.31:22 reachable
39.104.59.31:9527 reachable
39.104.59.31:8317 reachable
```

HTTP does not prove AIH is running:

```text
http://39.104.59.31:9527/healthz -> code=502 time=5.002394 size=0
http://39.104.59.31:9527/v0/fabric/descriptor -> code=502 time=5.001036 size=0
http://39.104.59.31:8317/healthz -> code=502 time=5.002316 size=0
```

SSH remains blocked at banner exchange even with 60s timeout:

```text
debug1: Connection established.
debug1: Local version string SSH-2.0-OpenSSH_10.3
Connection timed out during banner exchange
```

### Weak VPS Deploy Script

新增 `scripts/fabric-real-vps-deploy.js`，把后续部署策略固化为：

1. 本地执行 `npm run web:build`。
2. 通过 `tar | ssh tar` 传输源码和本地 `web/dist`，不依赖远端 `rsync`。
3. 传输真实账号导出包。
4. 远端执行 `npm install --ignore-scripts`，避免触发 postinstall / WebUI build。
5. 远端执行 `node bin/ai-home.js import <accounts.zip>`。
6. 远端用临时后台进程启动 `node bin/ai-home.js server serve --host 0.0.0.0 --port <port>`。

脚本不写 systemd、不改防火墙、不删除远端目录。

验证：

```text
node --test test/fabric-real-vps-deploy.test.js
pass 5/5

node --test test/fabric-*.test.js test/server-node-rpc-wiring.test.js
pass 41/41

npm run web:build
3668 modules transformed
built in 5.54s
```

Dry-run 输出证明恢复后可继续执行同一路径：

```text
[fabric-real-vps-deploy] target: root@39.104.59.31:/root/aih-fabric-real-20260626-215410
[fabric-real-vps-deploy] transfer-source: copy current source and local web/dist to remote
[fabric-real-vps-deploy] remote-install: npm install --ignore-scripts
[fabric-real-vps-deploy] remote-import: node bin/ai-home.js import /root/aih-fabric-real-20260626-215410/aih-accounts-real.zip
[fabric-real-vps-deploy] remote-start: port=18080
```

## AIH Claude Worker Check

用户要求复杂前端必须由 `aih claude` 参与。本轮真实执行：

```bash
node "bin/ai-home.js" claude -p "<FabricNodes frontend worker prompt>" --no-session-persistence
```

结果：

- CLI 进入 `Running claude (AIH Server) via PTY Sandbox`。
- 连续超过 60 秒停在 `Waiting for claude to boot`。
- 已中断。
- 没有获得 Claude 产出的前端 patch。

解释：当前 `aih claude` 可作为远程交互/PTY 入口，但还不能被视为稳定的非交互 patch worker。后续需要先产品化 worker entry：任务输入、文件范围约束、超时、结果回收、evidence 输出。

## Interpretation

- 这次不是 mock 或本地 loopback 验证；源码和真实账号导出包已实际传到 `39.104.59.31`。
- 远端弱机不适合承担 Web production build。1.6GB 内存机器在 Vite/Rollup 阶段可能拖垮 SSH 响应。
- 面向 2M-3M 小服务器的部署策略必须改为：本地构建 `web/dist`，远端只接收构建产物、运行 Node server、做账号导入和 registry publish。
- 由于 SSH banner 仍未恢复，本轮没有执行远端 `aih import`，也没有启动本次版本的 AIH server。因此不能宣称真实 VPS 部署完成。
- `39.104.59.31:9527/8317` 的 502 只能说明端口后面已有某个代理/服务，不是 AIH Fabric endpoint。
- 已有恢复后可直接执行的弱机部署脚本，但脚本通过不等于部署完成；必须等 SSH 恢复后跑真实导入、启动和 HTTP 验证。

## Verdict

partial

## Next Checks

1. 等 `39.104.59.31` SSH banner 恢复后，先杀残留 `node/npm/vite/tsc/rollup` 进程并记录资源状态。
2. 执行：

   ```bash
   node scripts/fabric-real-vps-deploy.js \
     --ssh root@39.104.59.31 \
     --accounts tmp/fabric-real-deploy/aih-accounts-real.zip \
     --remote-dir /root/aih-fabric-real-20260626-215410 \
     --port 18080
   ```

3. 远端以临时后台进程启动后，先不写 systemd。
4. 用 `curl /healthz`、`/v0/fabric/descriptor`、`/ui/` 验证真实 server。
5. 本地或另一台真实机器通过 device pair 拿 token，再执行 `aih fabric registry publish`，不要使用 smoke/mock registry。
6. 修复或产品化 `aih claude -p` worker 入口后，再让 Claude 负责 FabricNodes 前端修正。

## Follow-up

后续两台日本 VPS 已按随包 Node runtime 路径完成真实部署、真实账号导入和远端本机 server 验证，详见 `docs/fabric/evidence/2026-06-26-real-japan-vps-deploy.md`。`39.104.59.31` 的结论仍保留为弱机远端 build 失败证据，不代表日本 VPS 部署状态。
