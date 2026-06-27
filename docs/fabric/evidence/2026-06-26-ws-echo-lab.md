# 2026-06-26 WS Echo Lab

## Scope

验证 M1 Transport Lab 的最小 echo 闭环：

- 本地 `aih fabric transport echo-server` 能以前台临时进程启动。
- `aih fabric transport echo` 能连接 WebSocket echo endpoint 并输出 RTT 指标。
- `aih fabric transport tcp-echo` 能区分 TCP connect 成功和应用数据 echo 成功。
- 在 `39.104.59.31` 上做只读/临时公网链路尝试，不安装依赖、不写服务、不改远端配置。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-26
- Local shell: zsh
- Remote candidate: `root@39.104.59.31`
- Local proxy note: local shell has `http_proxy=http://127.0.0.1:6152`; HTTP evidence must bypass proxy with `curl -x ""` when measuring direct public reachability.

## Commands

Local CLI smoke:

```bash
node "bin/ai-home.js" fabric transport echo-server --host 127.0.0.1 --port 0 --path /echo --json
node "bin/ai-home.js" fabric transport echo "ws://127.0.0.1:<port>/echo" --count 3 --payload-size 16 --json
node "bin/ai-home.js" fabric transport tcp-echo-server --host 127.0.0.1 --port 0 --json
node "bin/ai-home.js" fabric transport tcp-echo "tcp://127.0.0.1:<port>" --count 3 --payload-size 16 --json
```

Remote capability check:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "node -e 'try{require(\"ws\"); console.log(\"ws=ok\")}catch(e){console.log(\"ws=missing\"); process.exit(2)}'"
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "hostname; node -v; python3 --version 2>&1; command -v timeout || true"
```

Remote temporary public echo attempt:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "<temporary Node http/ws echo server on 0.0.0.0:18768, timeout 60s>"
node "bin/ai-home.js" fabric transport probe "tcp://39.104.59.31:18768" --timeout-ms 3000 --json
curl -x "" -v --max-time 5 "http://39.104.59.31:18768/"
node "bin/ai-home.js" fabric transport echo "ws://39.104.59.31:18768/echo" --count 1 --payload-size 8 --timeout-ms 5000 --json
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "<temporary Node raw TCP echo server on 0.0.0.0:18770, timeout 60s>"
node "bin/ai-home.js" fabric transport probe "tcp://39.104.59.31:18770" --timeout-ms 3000 --json
node "bin/ai-home.js" fabric transport tcp-echo "tcp://39.104.59.31:18770" --count 1 --payload-size 8 --timeout-ms 5000 --json
```

Remote localhost control:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 "root@39.104.59.31" "node -e '<start localhost http server, curl it from same host, print body>'"
```

## Metrics

| metric | value | note |
|---|---:|---|
| Local echo CLI success | yes | `successes=3`, `p95=2ms` in smoke run |
| Remote node version | v22.22.1 | Node exists |
| Remote `ws` module | missing | no install performed |
| Remote `timeout` command | present | `/usr/bin/timeout` |
| Remote localhost HTTP self-check | pass | printed `ok` |
| Remote public TCP connect to 18768 | pass | `fabric transport probe` reachable in 2ms |
| Remote public HTTP response on 18768 | fail | direct curl connected, sent request, timed out with 0 bytes |
| Remote public WS echo on 18768 | fail | `echo_open_timeout` |
| Local TCP echo CLI success | yes | `successes=3`, `p95=1ms` in smoke run |
| Remote public TCP connect to 18770 | pass | `fabric transport probe` reachable in 2ms |
| Remote public TCP application echo on 18770 | fail | `tcp_echo_socket_closed`; remote process printed no `conn` or `data` logs |

## Results

Local echo smoke output:

```json
{"server":"ws://127.0.0.1:59863/echo","ok":true,"successes":3,"p95":2}
```

Local TCP echo smoke output:

```json
{"ok":true,"generatedAt":"2026-06-26T10:36:03.013Z","command":"aih fabric transport tcp-echo","target":"tcp://127.0.0.1:62727","count":3,"payloadSize":16,"durationMs":3,"successes":3,"failures":[],"rttMs":{"count":3,"min":0,"max":1,"avg":0.33,"p50":0,"p95":1}}
```

Remote capability:

```text
aliyun99
v22.22.1
Python 3.11.2
/usr/bin/timeout
ws=missing
```

Remote TCP probe:

```json
{
  "ok": true,
  "command": "aih fabric transport probe",
  "probes": [
    {
      "target": "tcp://39.104.59.31:18768",
      "reachable": true,
      "status": "reachable",
      "durationMs": 2
    }
  ]
}
```

Remote WS echo:

```json
{
  "ok": false,
  "command": "aih fabric transport echo",
  "target": "ws://39.104.59.31:18768/echo",
  "successes": 0,
  "failures": [
    { "id": "connect", "error": "echo_open_timeout" }
  ]
}
```

Remote server printed `ready 18768` but did not print HTTP or WebSocket request logs during the external curl/echo attempts.

Remote raw TCP echo attempt:

```json
{
  "ok": true,
  "command": "aih fabric transport probe",
  "probes": [
    {
      "target": "tcp://39.104.59.31:18770",
      "reachable": true,
      "status": "reachable",
      "durationMs": 2
    }
  ]
}
```

```json
{
  "ok": false,
  "command": "aih fabric transport tcp-echo",
  "target": "tcp://39.104.59.31:18770",
  "count": 1,
  "payloadSize": 8,
  "durationMs": 5005,
  "successes": 0,
  "failures": [
    { "id": "tcp-echo-1", "error": "tcp_echo_socket_closed" }
  ]
}
```

The remote raw TCP server printed `ready 18770` but did not print `conn` or `data` logs during the external probe or tcp-echo attempts.

## Interpretation

- The local echo lab is functional and can produce RTT evidence.
- `39.104.59.31` can run temporary Node servers locally, but the public path on high ports `18768` and `18770` only proves TCP connect; application data did not reach the Node process during these tests.
- This validates the product rule that `tcp reachable` is not enough to claim WSS/WebSocket or native session readiness.
- The next remote baseline should either open a known allowed port/security-group path, use 443 with a real reverse proxy/TLS setup, or run through the existing AIH server/relay route instead of ad hoc high ports.

## Verdict

partial

## Next Checks

- Check `39.104.59.31` security group/firewall for high-port inbound application traffic.
- Prefer WSS on 443 for public baseline, with a temporary cert or existing TLS terminator.
- Add evidence persistence later: write echo metrics into `network_measurements` once Fabric data store exists.
