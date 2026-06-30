# 2026-06-29 UDP probe concurrency classification

## Scope

This closes a real diagnostic failure mode found while running the current
Fabric closure gates against AWS current:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
port=9527
```

No mock data was used for the repro. The failure was caused by running two
default UDP diagnostics concurrently. Both attempted to bind the same real
AWS UDP port `9527`.

## Root cause

`closure audit`, `cloud-edge`, `prerequisites`, and `promotion-gate` all reuse
the shared default UDP probe. When two of those diagnostics run at the same
time, one remote inline UDP echo process successfully binds `0.0.0.0:9527` and
the other process fails with:

```text
bind EADDRINUSE 0.0.0.0:9527
```

Before this fix, the failed probe reported the generic
`turn_default_udp_probe_failed` blocker. That made a tool concurrency problem
look like an unknown network/cloud-edge failure.

## Fix

The shared UDP probe now classifies `EADDRINUSE` as:

```text
turn_default_udp_probe_busy
```

The blocker catalog maps it to:

```text
domain=diagnostic_concurrency
owner=aih
external=false
requiresConfirmation=false
nextAction=Run only one default UDP transport diagnostic at a time, then re-run cloud-edge or promotion-gate.
```

`cloud-edge` summary also adds the same retry guidance and does not add
`aws_public_udp_path_blocked` when packet capture did not run because the probe
was busy.

## Local verification

```text
node --check scripts/fabric-default-udp-probe.js
node --check scripts/fabric-cloud-edge-preflight.js
node --test test/fabric-default-udp-probe.test.js test/fabric-cloud-edge-preflight.test.js test/fabric-m6-prerequisite-audit.test.js test/fabric-m6-promotion-gate.test.js test/fabric-blocker-catalog.test.js
```

Result:

```text
focused tests: 51/51 pass
```

New regression coverage:

```text
default UDP probe classifies concurrent diagnostic bind as busy
cloud edge preflight summary separates concurrent UDP probe from cloud path blocker
blocker catalog classifies default UDP probe busy as diagnostic concurrency
```

## Real AWS concurrency verification

Command shape:

```text
Promise.all([
  runCloudEdgePreflight(AWS_CURRENT),
  runCloudEdgePreflight(AWS_CURRENT)
])
```

Result summary:

```text
probe_a.durationMs=3583
probe_a.udpBlockers=turn_default_udp_probe_busy
probe_a.remoteReady=false
probe_a.remoteError=bind EADDRINUSE 0.0.0.0:9527
probe_a.packetCapture.skipped=true
probe_a.summaryBlockers=turn_default_udp_probe_busy,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
probe_a.nextActions=Run only one default UDP transport diagnostic at a time; another probe is already binding UDP 9527.

probe_b.durationMs=10181
probe_b.udpBlockers=turn_default_udp_9527_unreachable
probe_b.remoteReady=true
probe_b.packetCapture.available=true
probe_b.packetCapture.captured=false
probe_b.packetCapture.stderr=0 packets captured / 0 packets received by filter / 0 packets dropped by kernel
probe_b.summaryBlockers=turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
```

## Current interpretation

Two separate facts are now preserved:

1. A concurrent diagnostic collision is a local/tooling retry condition, not
   AWS cloud-edge evidence.
2. A single non-conflicting UDP probe still proves the current AWS public UDP
   path is blocked: the echo process is ready, packet capture is ready on
   `enp39s0`, and zero UDP packets arrive.

Future Fabric closure runs should avoid parallelizing commands that bind the
default UDP probe port. If they are accidentally run in parallel, the report now
identifies the collision explicitly instead of sending the operator toward
Security Group/NACL debugging.
