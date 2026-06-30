# 2026-06-29 AWS Host Home Runtime Recheck

## Scope

After syncing commit `8f375dc` to AWS current, a real M6 prerequisite audit
found that the running default `9527` server had lost `AIH_HOST_HOME` in its
process environment.

This was a runtime drift issue, not a code or registry issue. The server still
answered `/readyz`, but the AWS base gate correctly failed because the server
process did not prove it was using:

```text
/home/ubuntu/aih-fabric-current/.aih-host-home
```

## Failed Gate

Command:

```text
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem"
```

Result:

```text
base_ready: no
aws:
  - aws_preflight_failed
  - server_host_home_mismatch
```

JSON showed:

```text
server.processes=["276554 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"]
server.expectedHostHome=/home/ubuntu/aih-fabric-current/.aih-host-home
server.hostHomes=[{ pid=276554, hostHome="", ok=false }]
```

## Runtime Repair

The server was restarted on the same default product port `9527` from the same
AWS current directory, with:

```text
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:$PATH
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

No provider accounts were imported, no old servers were touched, and no new
port was opened.

New server:

```text
server_pid=279373
readyz ok=true ready=false provider accounts all 0
```

Long-running services after repair:

```text
registry-agent pid=276850
server pid=279373
relay-node pid=279398
```

## Passing Gate

Re-run prerequisite audit:

```text
base_ready: yes
promotion_ready: no
ready_transports: none
aws: candidate=yes promotion=yes
turn: candidate=no promotion=no
  - turn_ice_server_not_configured
webtransport: candidate=no promotion=no
  - webtransport_connect_failed
multipath: candidate=yes promotion=no
  - local_mptcp_unavailable
  - openmptcprouter_not_detected
  - default_listener_is_plain_http_not_multipath_transport
```

Important JSON evidence:

```text
server.readyzHttp=200
server.processCount=1
server.processes=["279373 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"]
server.expectedHostHome=/home/ubuntu/aih-fabric-current/.aih-host-home
server.hostHomes=[{ pid=279373, hostHome="/home/ubuntu/aih-fabric-current/.aih-host-home", ok=true }]
serviceStatus.ok=true
serviceStatus.supervisorReady=true
registry.counts=nodes:2 relayNodes:2 projects:2 runtimes:4 transports:3 nodeInventory:2
aws.blockers=[]
summary.baseReady=true
summary.promotionReady=false
```

Promotion gate after repair:

```text
promotion_ready: no
default_transport: relay
relay: candidate=yes promotion=yes
webrtc: candidate=yes promotion=no
  - turn_relay_gate_not_ready
turn: candidate=no promotion=no
  - turn_ice_server_not_configured
webtransport: candidate=no promotion=no
  - webtransport_connect_failed
multipath: candidate=yes promotion=no
  - local_mptcp_unavailable
  - openmptcprouter_not_detected
  - default_listener_is_plain_http_not_multipath_transport
```

## Conclusion

AWS base readiness is restored. M6 remains blocked only by the real external
transport prerequisites:

- controlled TURN relay `iceServers`/credentials;
- HTTPS/H3 WebTransport endpoint;
- real OpenMPTCPRouter/Linux underlay.

Default transport stays `relay`.
