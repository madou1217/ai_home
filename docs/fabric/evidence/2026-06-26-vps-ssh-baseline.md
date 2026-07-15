# 2026-06-26 VPS SSH Baseline

## Scope

只读验证 3 台用户提供的 VPS 是否可作为 AIH Fabric transport lab 的 server/relay node 候选。未安装软件，未修改远端配置。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-26
- Local shell: zsh
- Remote candidates:
  - `opc@152.70.105.41`
  - `ubuntu@155.248.183.169`
  - `root@39.104.59.31`

## Commands

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 "opc@152.70.105.41" "hostname; uname -a; command -v node || true; command -v curl || true; command -v python3 || true"
ssh -o BatchMode=yes -o ConnectTimeout=8 "ubuntu@155.248.183.169" "hostname; uname -a; command -v node || true; command -v curl || true; command -v python3 || true"
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "hostname; uname -a; command -v node || true; command -v curl || true; command -v python3 || true"
ssh -o BatchMode=yes -o ConnectTimeout=25 "opc@152.70.105.41" "hostname; uname -a"
ssh -o BatchMode=yes -o ConnectTimeout=25 "ubuntu@155.248.183.169" "hostname; uname -a"
nc -vz -w 8 "152.70.105.41" 22
nc -vz -w 8 "155.248.183.169" 22
nc -vz -w 8 "39.104.59.31" 22
node "bin/ai-home.js" fabric transport probe "tcp://39.104.59.31:22" "tcp://152.70.105.41:22" "tcp://155.248.183.169:22" --timeout-ms 3000 --json
```

## Metrics

| metric | value | note |
|---|---:|---|
| SSH command success | 1/3 | `39.104.59.31` only |
| TCP 22 success | 3/3 | all hosts accept TCP connection |
| `fabric transport probe` TCP 22 success | 3/3 | all hosts reported `reachable` |
| Oracle SSH banner timeout | 2/2 | both Oracle hosts timed out after 8s and 25s |

## Results

| Host | TCP 22 | SSH command | Evidence |
|---|---:|---:|---|
| `opc@152.70.105.41` | ok | failed | `Connection timed out during banner exchange` after 8s and 25s |
| `ubuntu@155.248.183.169` | ok | failed | `Connection timed out during banner exchange` after 8s and 25s |
| `root@39.104.59.31` | ok | ok | hostname `aliyun99`, Debian kernel `6.1.0-33-amd64`, node/curl/python3 present |

`aih fabric transport probe` JSON summary:

```json
{
  "ok": true,
  "command": "aih fabric transport probe",
  "timeoutMs": 3000,
  "probes": [
    { "target": "tcp://39.104.59.31:22", "reachable": true, "status": "reachable" },
    { "target": "tcp://152.70.105.41:22", "reachable": true, "status": "reachable" },
    { "target": "tcp://155.248.183.169:22", "reachable": true, "status": "reachable" }
  ]
}
```

## Interpretation

- `152.70.105.41` and `155.248.183.169` are reachable at TCP level, but SSH does not complete banner exchange within 25 seconds. This is not an authentication failure.
- `39.104.59.31` is immediately usable as the first relay/server lab host.
- Before using the two Oracle hosts as relay nodes, verify sshd responsiveness, security group/firewall behavior, host load, and whether an intermediate network path is delaying SSH banner delivery.

## Verdict

partial

## Next Checks

- Run a longer TCP and SSH banner capture from another network, if available.
- On `39.104.59.31`, run WSS echo and relay baseline first.
- Do not install AIH Fabric services on the two Oracle hosts until SSH responsiveness is explained.
