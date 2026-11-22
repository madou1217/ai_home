# Remote Execution Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建立统一的 Remote Execution Target 解析和预检入口，让 CLI/WebUI 能明确表达“哪个 AIH Server、哪个 SSH Workspace、哪个 Harness、哪个 Provider/Account/Model”，并为后续 AWS Agent 执行、Job 和观测复用同一目标身份。

**Architecture:** 在 Go 侧新增小型 `remoteexecution` domain/application 层：只负责规范化输入、解析 target、生成 preflight 结果，不直接启动 Provider 或操作 SSH。HTTP handler 是入站适配器，CLI 是另一个入站适配器；两者都调用同一 resolver。后续 Agent Supervisor、Remote Tool Session 和 WebUI 观测只接收已解析的 target snapshot，不再从 projectPath 或当前激活 Server 猜测。

**Tech Stack:** Go 1.x、现有 `server profiles`/Control Plane HTTP client、现有 SSH workspace read model、现有 provider/harness catalog、Node/React WebUI API conventions。

**Spec:** `docs/superpowers/specs/2026-11-22-remote-execution-target-design.md`

## Global Constraints

- Provider、账号、模型和 Agent/Harness 必须留在远程 AIH Server；本地不做模型 relay。
- 不静默 fallback 到本机 Agent、错误 Server 或 shadow workspace。
- 不继续扩展 `internal/transport/http/webuisshapi/remote_agent.go` 作为第二套启动体系。
- Target 必须同时保存控制面 Server Profile 身份和远程 Workspace 身份。
- 本阶段不写测试用例；使用真实编译、CLI、HTTP 和现有运行时状态验证。
- 只提交本阶段显式路径；保留共享工作区和并行会话改动。

### Task 1: Remote Target domain and resolver

**Files:**
- Create: `internal/remoteexecution/target.go`
- Create: `internal/remoteexecution/resolver.go`
- Create: `internal/remoteexecution/preflight.go`
- Modify: `internal/remoteexecution/...` only if a focused helper is required

**Interfaces:**
- Consumes: sanitized server profile data, SSH connection/workspace data, explicit target selectors.
- Produces: `TargetSelector`, `ExecutionTarget`, `TargetResolution`, `PreflightReport` and stable error codes for CLI/HTTP adapters.

- [ ] Define immutable selector and resolved target structs with explicit IDs for server profile, server identity, SSH connection, workspace, harness, provider, account and model.
- [ ] Implement deterministic selection rules: explicit selector first; otherwise active server only; workspace/provider/account/model may use a single unambiguous match; ambiguous or missing values fail with a stable code.
- [ ] Keep model fields separate as catalog model ID and runtime/CLI model name; do not claim model availability from a catalog string alone.
- [ ] Implement preflight as pure aggregation of available facts, with stages for server, workspace, harness, provider, account and model; unsupported or missing stages must be visible rather than converted to success.
- [ ] Run `gofmt` and `go vet`/package build for the new package; no test files are added.
- [ ] Commit with an explicit pathspec: `feat(remote): add execution target resolver`.

### Task 2: Server-side management API

**Files:**
- Create: `internal/transport/http/webuiremotetargetsapi/handler.go`
- Create: `internal/transport/http/webuiremotetargetsapi/source.go`
- Modify: `internal/host/aihserver/router.go` or the focused route composition file that owns management routes
- Modify: the focused server-side catalog adapters needed to read current provider/account/model facts

**Interfaces:**
- Consumes: `remoteexecution.Resolver` and existing management authorization/profile/workspace/catalog sources.
- Produces: `GET /v1/management/webui/remote-targets`, `GET /v1/management/webui/remote-targets/resolve`, and `GET /v1/management/webui/remote-targets/preflight` with explicit JSON error codes.

- [ ] Add a read-only handler with authorization and no credential fields in responses.
- [ ] Return target candidates with stable IDs and capability/status summaries; do not expose raw management keys, passwords, private keys or tokens.
- [ ] Make query selectors explicit (`serverProfileId`, `workspaceId`, `harness`, `provider`, `accountRef`, `model`) and reject unknown/ambiguous combinations.
- [ ] Register the routes through the existing route composition, without changing legacy SSH or chat route semantics.
- [ ] Build the server and exercise the endpoint against the local running Server; record the exact response and unsupported stages.
- [ ] Commit with explicit pathspec: `feat(remote): expose target resolution and preflight`.

### Task 3: CLI `aih remote`

**Files:**
- Create: `cmd/aih/remote.go`
- Modify: `cmd/aih/run.go`
- Modify: `cmd/aih/complete.go` and the focused completion source
- Modify: `cmd/aih/server_help.go` or the focused root help source

**Interfaces:**
- Consumes: the server-side management API through the existing Server Profile transport and `remoteexecution` selector model.
- Produces: `aih remote target ls [--json]`, `aih remote target resolve ...`, `aih remote target doctor ...`, and completion candidates for server/workspace/harness/provider/account/model.

- [ ] Parse only remote subcommands in the new file; keep root dispatch and provider launch logic small.
- [ ] Use explicit `--server`, `--workspace`, `--harness`, `--provider`, `--account`, and `--model` selectors.
- [ ] Render concise human output and stable JSON output from the same response model.
- [ ] Never use local provider/account/model discovery as a fallback after a remote query fails.
- [ ] Add completion branches that query the selected Server and narrow candidates progressively; return an observable remote-catalog-unavailable result instead of local guesses.
- [ ] Build the CLI and run real commands against the current local Server, including missing/ambiguous target diagnostics.
- [ ] Commit with explicit pathspec: `feat(remote): add target CLI and completion`.

### Task 4: WebUI target panel and observer foundation

**Files:**
- Create: `web/src/features/remote-targets/RemoteTargetPanel.tsx`
- Create: `web/src/features/remote-targets/remote-targets-model.ts`
- Create: `web/src/features/remote-targets/remote-targets.css`
- Modify: `web/src/services/api.ts`
- Modify: the existing SSH/Work entry point that owns the remote workspace panel

**Interfaces:**
- Consumes: the new read-only target list/resolve/preflight API.
- Produces: a compact target summary, preflight stage list, and explicit unsupported/error states; no broad Alert blocks or left-side status bars.

- [ ] Add API methods and typed response models with server/workspace/harness/provider/account/model identity.
- [ ] Render the active target summary and preflight stages with inline labels/icons/actions.
- [ ] Preserve existing SSH workspace and terminal actions; do not replace semantic action icons with provider logos.
- [ ] Keep this panel desktop-only and avoid unrelated mobile layout changes.
- [ ] Run the Web build and inspect the real page for the visual constraints and console errors.
- [ ] Commit with explicit pathspec: `feat(remote): add target overview panel`.

### Task 5: Real runtime acceptance and handoff

**Files:**
- No product source changes unless an acceptance finding requires a focused correction.
- Create: an evidence note under `run/` containing only command output, response JSON, hashes and acceptance conclusions.

- [ ] Verify current CLI target listing and doctor output.
- [ ] Verify current WebUI target panel through the existing supported browser connection if available; do not launch a second browser and do not use AppleScript/Apple Events.
- [ ] Verify that no target resolution silently falls back to local Provider/Harness or shadow execution.
- [ ] Report the boundary: this slice resolves and diagnoses targets; it does not claim successful AWS AGY inference/tool loop until a real AWS target is configured and exercised.
- [ ] Inspect staged diff and commit stats after every scoped commit; do not amend or reset shared history.

## 执行状态（2026-11-22 续作）

Task 1–4 已实现、构建并通过真实 CLI/HTTP/WebUI 构建检查：

- `internal/remoteexecution` 目标解析、preflight、connector transport；
- `webuiremotetargetsapi` 只读目标 API；
- `aih remote target ls|resolve|doctor` 与补全；
- `RemoteTargetPanel` 目标概览；
- 追加 Phase 1：Workspace Connector enrollment/store、WebSocket、受限文件 RPC、
  `aih workspace connect|ls|enroll|revoke`、WebUI 本地工作区面板。

Task 5 的 CLI/HTTP/runtime 真实验收已完成，证据见
`docs/remote/2026-11-22-workspace-connector.md`。WebUI 面板已在真实 Chromium 中检查
（Work 模式、在线状态、目录浏览、生成 code；无 console error）。尚未完成：

- AWS 服务器 + AGY + `gemini-4-neon-xhigh` 的真实 Agent 工具循环（属于 Provider
  Adapter 阶段；当前 preflight 明确保持 `remote_tools_unsupported`）。
