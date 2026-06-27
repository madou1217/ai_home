# 2026-06-26 Server Profile Gate Smoke

## Scope

验证 M2 Server Profile 解耦的第一刀：

- 客户端无 ready server profile 时，不能直接进入 Dashboard / Chat 等旧 WebUI 页面。
- 无 ready server profile 时，入口必须落到独立 `/ui/server-setup`，让用户先添加、探测或配对 server。
- 已有 paired profile 时，不能误拦进入 Chat。
- 本轮只验证路由级 gate、独立 Server Setup 首屏和 profile selector；不宣称真实远端 pairing endpoint 已完成。

## Environment

- Local cwd: `/Users/model/projects/feature/ai_home`
- Date: 2026-06-26
- Web dev server: `http://127.0.0.1:3000/ui/`
- Browser automation: Playwright CLI wrapper

## Commands

Build:

```bash
npm run web:build
```

Focused gate test:

```bash
node --test test/fabric-profile-gate.test.js
```

Dev server:

```bash
cd web
npm run dev -- --host 127.0.0.1
```

No-ready-profile route check:

```bash
playwright-cli open http://127.0.0.1:3000/ui/
playwright-cli snapshot
```

Ready-profile route check:

```bash
playwright-cli localstorage-set aih:control-plane-profiles:v1 '<paired profile json>'
playwright-cli localstorage-set aih:active-control-plane-profile:v1 cp-ready-smoke
playwright-cli goto http://127.0.0.1:3000/ui/chat
playwright-cli snapshot
```

## Metrics

| metric | value | note |
|---|---:|---|
| Web build | pass | `tsc && vite build` completed |
| Focused gate test | pass | `test/fabric-profile-gate.test.js`, 3/3 pass |
| `/ui/` without ready profile | pass | redirected to `/ui/server-setup` |
| Server Setup first screen | pass | pair form, probe form, saved server list, loopback warning visible |
| Sidebar config link | pass | href is `/ui/server-setup` |
| Advanced settings link | pass | href is `/ui/settings?tab=control-planes` |
| Ready paired profile to `/ui/chat` | pass | stayed on `/ui/chat` |
| Ready server selector | pass | displayed `Ready Smoke · 0/2 在线` |

## Results

Initial open result:

```text
Page URL: http://127.0.0.1:3000/ui/server-setup
Page Title: AI Home Console
```

Snapshot evidence showed:

- Sidebar server selector: `当前 Control Plane (未配对)`.
- Sidebar config link: `/ui/server-setup`.
- Main panel: `AIH Fabric -> 选择或添加 Server`.
- Loopback warning visible for `127.0.0.1 / localhost`.
- Add/pair sections visible: `通过配对添加`, `探测并保存`, `已保存 Server`.
- `进入工作台` disabled because active profile was not ready.

Ready-profile simulation:

```text
Page URL: http://127.0.0.1:3000/ui/chat
Sidebar server selector: Ready Smoke · 0/2 在线
Config link: /ui/server-setup
```

The simulated profile intentionally used the minimum code-required shape:

```text
authState=paired
state=paired
deviceToken=smoke-token
```

Console notes:

- Development-only React Router v7 future warnings.
- Re-run after Server Setup state initialization fix: 0 console errors.
- No real backend pairing was exercised in this smoke; this file is only about client route gate and ready-profile selection. Fabric endpoint pairing is covered by `2026-06-26-fabric-server-endpoint-smoke.md`.

## Interpretation

- M2 now has a real client-side gate: no ready server profile cannot enter old local WebUI pages by default.
- The gate now lands on a dedicated first-run Server Setup page instead of the full Settings page.
- The gate reuses existing Control Plane profile storage and active profile resolution; it does not introduce a second profile source.
- `Settings -> 控制面` remains available as an advanced page, but it is not the default onboarding surface.

## Verdict

pass

## Next Checks

- Add focused Web tests for `fabric-profile-gate` and `FabricServerSetup` storage behavior.
- Run a real browser pairing smoke against `/v0/fabric/device-pair`.
- Add a production smoke with a real paired server and device token, then verify Dashboard / Nodes / Chat data loading.
