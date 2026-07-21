# 2026-06-27 M3 Fabric Nodes Mobile Regression

## Scope

验证 M3 7.5：

```text
AWS current default 9527
-> real mobile viewport browser
-> real device pairing profile
-> Fabric Nodes multi-node page
-> node list and detail switching
-> no horizontal overflow / no blank first viewport / no console errors
```

本轮只使用 AWS current 和本机 Chrome headless，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| AWS server pid | `121002` |
| Public UI endpoint | `http://43.207.102.163:9527/ui/fabric/nodes` |
| Mobile viewport | `390x844`, `deviceScaleFactor=3`, touch enabled |
| Top screenshot | `/tmp/aih-m3-fabric-nodes-mobile-390-fixed.png` |
| Detail screenshot | `/tmp/aih-m3-fabric-nodes-mobile-390-detail.png` |

## Commands

Create a real device pair invite without printing the token:

```text
createControlPlaneDeviceInvite({
  name: "Fabric Nodes Mobile Smoke",
  controlEndpoint: "http://43.207.102.163:9527",
  scopes: ["control-plane:read", "nodes:read"]
})
```

Browser flow:

```text
Chrome headless + CDP
Emulation.setDeviceMetricsOverride(width=390, height=844, deviceScaleFactor=3, mobile=true)
POST real pair URL with device id mobile-smoke-fabric-nodes-20260627
Store the returned device token in localStorage as an active Control Plane profile
Navigate to http://43.207.102.163:9527/ui/fabric/nodes
Click the local-mac-remote-node row
Capture top and detail screenshots
```

## Finding

The first real mobile screenshot was blank even though the DOM text existed. Layout metrics showed:

```json
{
  "fabricNodesPageY": -1008,
  "fabricNodesPageHeight": 3603,
  "viewportHeight": 844
}
```

Root cause: mobile `.app-content` was a flex child without a stable height/flex boundary, so long Fabric content was laid out above the visible viewport inside the fixed-height shell.

Fix:

```css
.app-content.ant-layout-content {
  height: 100%;
}

@media (max-width: 768px) {
  .app-content.ant-layout-content {
    height: 100%;
    flex: 1 1 auto;
  }
}
```

## Results

| check | result |
|---|---|
| Real pairing | HTTP 200, token returned to browser localStorage only |
| Mobile viewport | `390x844`, touch enabled |
| Header position after fix | `headerRect.y=106` |
| Page position after fix | `pageRect.y=68` |
| Content scroll container | `clientHeight=720`, `scrollHeight=3633`, `scrollTop=0` at top |
| Horizontal overflow | false, `scrollWidth=390`, `clientWidth=390` |
| Overflow elements | `[]` |
| Node rows | 2 |
| Node detail switch | click selected `local-mac-remote-node`, detail title `Local Mac Remote Node` |
| Top viewport | Fabric title, active server, node/relay/project counts visible |
| Detail viewport | roles, platform, capabilities, projects and runtimes visible |
| Relay health metrics | `p95`, `100% ok (20)`, `ws_echo_pass` present in page text |
| Console | 0 warnings/errors/exceptions |
| Web build | pass; only existing Vite chunk-size warning |

Sanitized top viewport check:

```json
{
  "viewport": {
    "width": 390,
    "height": 844
  },
  "scrollWidth": 390,
  "clientWidth": 390,
  "hasHorizontalOverflow": false,
  "rowCount": 2,
  "activeRow": "local-mac-remote-node",
  "detailTitle": "Local Mac Remote Node",
  "headerRect": {
    "x": 22,
    "y": 106,
    "w": 346,
    "h": 25.296875
  },
  "pageRect": {
    "x": 10,
    "y": 68,
    "w": 370,
    "h": 3603.421875
  },
  "contentScroll": {
    "top": 0,
    "h": 720,
    "scrollH": 3633
  },
  "hasFabricTitle": true,
  "hasAwsNode": true,
  "hasLocalNode": true,
  "hasRelayHealth": true,
  "hasP95": true,
  "hasSuccessRate": true,
  "hasWsEcho": true,
  "overflowEls": [],
  "consoleIssueCount": 0
}
```

Sanitized detail check:

```json
{
  "contentScrollTop": 1580,
  "detailTitle": "Local Mac Remote Node",
  "hasLocalDetail": true,
  "hasProject": true,
  "hasRuntime": true,
  "hasTransport": true,
  "hasRelayMeta": true,
  "hasP95": true,
  "hasSuccessRate": true,
  "overflowX": false,
  "activeRow": "local-mac-remote-node",
  "consoleIssueCount": 0
}
```

## Interpretation

- 7.5 found a real mobile-shell layout bug; it is fixed in the shared app shell, not patched by offsetting FabricNodes.
- Fabric Nodes can now be used from a phone-sized viewport: the page starts in view, scrolls inside the content area, shows two real nodes, and supports node detail switching.
- This evidence does not install or start supervised daemon services; M3 7.3 remains pending explicit confirmation for AWS config/systemd writes.

## Verdict

pass

M3 subtask 7.5 is complete. The only remaining M3 gate is 7.3 real supervised daemon install/start.
