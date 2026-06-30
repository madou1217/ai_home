# 2026-06-28 M6 Multipath / MPTCP / OpenMPTCPRouter Diagnosis

## Scope

验证 M6 transport promotion 里 Multipath/MPTCP/OpenMPTCPRouter 这条路线是否能在当前真实环境中启用。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认外部端口 `9527`。
- 不触碰旧服务器。
- 不安装系统包、不改内核参数、不开放端口、不启动新服务。
- 不把 TCP/HTTP 可达冒充成 Multipath 可用。

## Code Added

新增只读诊断入口：

```text
node scripts/fabric-multipath-diagnosis.js --json
```

诊断内容：

- 本机 MPTCP capability：`sysctl`、Python `socket.IPPROTO_MPTCP`、OpenMPTCPRouter marker。
- AWS MPTCP capability：`/proc/sys/net/mptcp/enabled`、`sysctl net.mptcp.enabled`、`ip mptcp`、`ss -Mai`、Python `socket.IPPROTO_MPTCP`。
- AWS default `9527`：真实 TCP connect、`/readyz`、remote listener ownership。
- 输出 `blockers` 和 `promotionReady`，防止把普通 AIH HTTP listener 误判为 multipath transport。

Focused test：

```text
node --check scripts/fabric-multipath-diagnosis.js
node --test test/fabric-multipath-diagnosis.test.js
tests 6
pass 6
fail 0
node --test test/fabric-m3-daemon-preflight.test.js test/fabric-multipath-diagnosis.test.js
tests 19
pass 19
fail 0
npm test
tests 2625
pass 2625
fail 0
```

## Real Diagnosis

Command：

```text
node scripts/fabric-multipath-diagnosis.js --json
```

Target：

```json
{
  "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
  "ssh": "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com"
}
```

Local result：

```json
{
  "platform": "Darwin",
  "arch": "arm64",
  "kernelMptcp": false,
  "pythonMptcpSocket": false
}
```

AWS result：

```json
{
  "platform": "Linux",
  "arch": "x86_64",
  "kernelMptcp": true,
  "pythonMptcpSocket": true,
  "listener9527": "tcp LISTEN 0 511 0.0.0.0:9527 users:((\"node\",pid=225598,fd=27))"
}
```

Default port result：

```json
{
  "tcp": {
    "ok": true,
    "port": 9527,
    "durationMs": 7
  },
  "readyz": {
    "ok": true,
    "service": "aih-server",
    "ready": false,
    "accounts": {
      "codex": 0,
      "gemini": 0,
      "claude": 0,
      "agy": 0,
      "opencode": 0
    }
  }
}
```

Summary：

```json
{
  "defaultPortReachable": true,
  "openMptcpRouterDetected": false,
  "blockers": [
    "local_mptcp_unavailable",
    "openmptcprouter_not_detected",
    "default_listener_is_plain_http_not_multipath_transport"
  ],
  "promotionReady": false,
  "verdict": "diagnostic_pass_promotion_blocked"
}
```

## Interpretation

AWS alone has kernel/runtime MPTCP capability, but that does not make the current AIH Fabric path multipath:

- The local Mac side does not expose generic MPTCP socket support in this diagnostic.
- No OpenMPTCPRouter marker is present locally or on AWS.
- The externally reachable default `9527` listener is the normal Node AIH HTTP server, not a multipath-aware listener.

## Verdict

`diagnostic_pass_promotion_blocked`

Multipath/MPTCP/OpenMPTCPRouter cannot be promoted under the current topology. It remains a candidate underlay, not a default product transport.

To turn this into a pass later, the product needs real evidence from one of these paths:

1. A Linux/Linux or router-assisted topology where both endpoints have MPTCP-capable sockets and at least two usable subflows.
2. A real OpenMPTCPRouter deployment in front of the no-public-IP machines, with AIH traffic routed through that underlay and measured from Fabric diagnostics.
3. A default-port-compatible multipath gateway that keeps external `9527` stable while proving application traffic is actually using multipath, not plain TCP.
