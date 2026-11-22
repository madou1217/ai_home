# Network Connector Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move future network access integrations out of AIH core while exposing a generic, visually manageable connector contract for independently updated plugins.

**Architecture:** AIH core owns only the signed plugin lifecycle, capability discovery, generic invocation, authorization, and evidence-shaped presentation. A network plugin owns vendor-specific installation, configuration, service control, and connectivity diagnostics. Cloudflare Tunnel, Tailscale, WireGuard, and future connectors must not be added to the core tool catalog or edge-provider switch; they contribute `network.connector` through an external plugin package.

**Tech Stack:** Go plugin host and HTTP management routes, generated plugin contract JSON/Go/Node/TypeScript artifacts, React 18 + Ant Design WebUI, existing process-plugin JSON-RPC runtime.

**Spec:** `docs/plugins/network-connector-plugin-contract.md`

## 落地状态

已完成：契约（network.connector@1）、Go 宿主与两条管理路由、通用 WebUI 面板、未安装工具的服务控件保护、核心 Cloudflare provider 撤回。
验证：聚焦 Go 测试、Node 语法与契约检查、git diff --check、Web 生产构建均通过；tsc --noEmit 仍被仓库既有 @umijs/max 类型导出问题挡住。
未验证：没有真实 Tailscale/WireGuard/Cloudflare 外部插件，因此不声称已打通 P2P；真实验收必须等插件包接入后按 Task 5 收集证据。

## Global Constraints

- Do not add vendor-specific Tailscale, WireGuard, Cloudflare, or other future provider branches to core `edgeproxy` or `toolkit/tools`.
- Keep plugin package install/uninstall/enable/disable distinct from connector tool install/uninstall/enable/disable.
- Report direct P2P, peer relay, DERP/relay, outbound tunnel, and unavailable as distinct connectivity states; never label relay or outbound tunnel as direct P2P.
- Do not echo credentials, private keys, auth tokens, or plugin configuration values in list/status responses.
- Do not add test cases; validate with existing focused tests, real CLI probes, TypeScript checks, and a production build.
- Preserve unrelated parallel-session changes and use explicit pathspecs for every commit.

---

### Task 1: Define the external network connector contract

**Files:**
- Create: `docs/plugins/network-connector-plugin-contract.md`
- Modify: `contracts/plugins/contract.json`
- Regenerate: `contracts/plugins/contract.generated.go`, `lib/plugins/sdk/contract.generated.json`, `lib/plugins/sdk/manifest.schema.generated.json`, `lib/plugins/sdk/wire.generated.d.ts`
- Verify: `scripts/generate-plugin-contract.js --check`

**Interfaces:**
- Adds capability `network.connector` version 1, mode `collect`.
- `describe` returns connector identity, transport class, supported lifecycle operations, config schema, and connectivity evidence vocabulary.
- `status` returns redacted installation/service/connectivity status.
- `operate` accepts only declared actions and returns a structured operation result.

- [x] Add the capability to the single source contract and regenerate generated artifacts.
- [x] Document plugin lifecycle versus connector lifecycle and the P2P evidence boundary.
- [x] Document a process-runtime example suitable for a separately maintained plugin package.
- [x] Run the contract generator check and inspect the generated diff.
- [x] Commit only the contract and documentation paths.

### Task 2: Add a generic Go host facade and management API

**Files:**
- Create: `internal/runtime/pluginhost/network_connector.go`
- Modify: `internal/transport/http/webuipluginapi/handler.go`
- Modify: `internal/host/aihserver/webui_plugin_routes.go`
- Modify: `internal/transport/http/webuipluginapi/handler.go` error mapping if needed

**Interfaces:**
- `Service.ListNetworkConnectors(ctx)` discovers active `network.connector` contributions.
- `Service.OperateNetworkConnector(ctx, connectorID, action, input)` invokes the selected contribution without vendor-specific code.
- `GET /v1/management/webui/plugins/network-connectors` returns descriptors plus redacted status.
- `POST /v1/management/webui/plugins/network-connectors/{connectorId}` executes a declared connector action.

- [x] Normalize and validate descriptor/status responses, reject duplicate connector IDs, and cap response sizes.
- [x] Preserve failure policy and return structured errors; do not turn a relay/unknown state into success.
- [x] Add exact HTTP route registration and management authorization.
- [x] Run existing pluginhost and webuipluginapi tests without adding tests.
- [x] Commit the generic host/API paths only.

### Task 3: Add a vendor-neutral Toolkit panel

**Files:**
- Create: `web/src/components/toolkit/NetworkConnectorPanel.tsx`
- Modify: `web/src/services/api.ts`
- Modify: `web/src/types/index.ts`
- Modify: `web/src/pages/Toolkit.tsx`

**Interfaces:**
- Fetches connector descriptors/status from the generic API.
- Renders only plugin-provided display names and declared operations.
- Shows connectivity as direct P2P, peer relay, DERP/relay, outbound tunnel, or unavailable.
- Sends config/action payloads without rendering secret values.

- [x] Add typed API methods and response models.
- [x] Add the panel under the network section without hardcoding vendor providers.
- [x] Keep visual states compact and obey the repository alert/left-bar restrictions.
- [x] Gate buttons by declared operation and current installed/enabled status.
- [x] Run `pnpm exec tsc --noEmit` and production build.
- [x] Commit only the WebUI/API paths.

### Task 4: Remove the in-flight Cloudflare provider from core catalogs

**Files:**
- Modify: `internal/runtime/edgeproxy/providers.go`
- Modify: `internal/runtime/edgeproxy/service.go`
- Modify: `internal/runtime/toolkit/tools/plugins.go`
- Modify: `lib/cli/commands/edge-router.js`
- Modify: `lib/cli/complete/command-tree.js`
- Modify: `internal/runtime/completion/commandtree.go`
- Modify: `internal/runtime/completion/descriptions.go`
- Modify: `web/src/components/toolkit/edge-proxy/*`
- Modify: `web/src/pages/Toolkit.tsx`
- Delete or relocate only the in-flight core helper `lib/cli/services/toolkit/edge-proxy/providers/cloudflared.js`

**Interfaces:**
- Core edge provider list remains frp/nginx/caddy.
- Cloudflare/Tailscale/WireGuard are discovered via `network.connector` plugins instead of core switches.
- Existing not-installed service protections remain intact.

- [x] Remove only Cloudflare-specific additions from the current worktree; preserve unrelated service gating fixes.
- [x] Remove stale Cloudflare completion/help/UI branches.
- [x] Verify no core catalog or edge switch mentions the new providers.
- [x] Run focused Go tests, Node syntax checks, `git diff --check`, and frontend checks.
- [x] Commit the cleanup as a separate scoped commit.

### Task 5: Real validation and handoff

**Files:**
- No new test files.
- Evidence may be written only as compact logs/manifests if needed; never copy the source tree.

- [x] Run existing focused Go tests for pluginhost, webuipluginapi, edgeproxy, and toolkit tools.
- [x] Run Node syntax checks for changed CLI files and the contract generator check.
- [x] Run TypeScript no-emit and production build.
- [x] Inspect `git diff --cached --stat`, `git show --stat HEAD`, and `git status --short` before/after each commit.
- [x] Report the evidence boundary: no Tailscale/WireGuard live installation or P2P acceptance is claimed until an external plugin package is installed and `tailscale status/ping` or WireGuard handshake/endpoint evidence is captured.
