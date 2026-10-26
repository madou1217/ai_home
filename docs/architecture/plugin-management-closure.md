# Plugin Management Closure Evidence

状态：Task 1 baseline harness

本文件记录插件、Skill、MCP 和原生 provider 管理的实际闭环证据。每个资源必须证明安装/投影、启用、实际使用、停用和移除；静态 manifest 或目录存在不能单独证明完成。

## AIH Plugin baseline

The deterministic harness is:

```bash
node --test test/plugin-management-closure.test.js
node scripts/plugin-closure-demo.js --json
```

It uses `examples/plugins/echo` and a temporary AIH home. The expected stages are:

```text
pack → install → enable → use → restart → use-after-restart → disable → uninstall → doctor
```

The demo only prints a temporary-home marker, digest, plugin id, generation, lifecycle state, and explicit marker values. It does not print credentials, configuration values, management keys, or full request bodies.

## Native resource baseline

`test/native-resource-management.test.js` reads the generated provider manifest and emits a result for `plugin`, `skill`, and `mcp` for every provider. Before the managers are installed, the honest states are `projection-only` or `unsupported`; the test rejects missing reasons and rejects silently claiming `supported`.

The matrix will be upgraded as Tasks 3–7 add descriptor-driven managers and real probes. A provider remains `projection-only` until the corresponding native CLI or runtime is exercised.

## Imported platform gap tracking

| Platform | Existing source model | AIH closure status at baseline |
|---|---|---|
| DeepSeek Harness | npm bundle, `dsh.bundle.patch`, profile ordered layers, Cordis lifecycle | Adapter/projection planned; no AIH manager demo yet |
| OpenCode | npm/local server/TUI/RPC plugin entrypoints, Effect Scope/generation | Existing session hook bridge only; native plugin manager not yet closed |
| Pi | npm/git/local package with `pi.extensions`, extension factory and session events | Runtime package may be absent; projection/conformance required before runtime claim |
| AIH | signed/hashed `.aih-plugin`, supervised Host, generation and RPC | Echo lifecycle harness is the first executable closure |

The final evidence must replace each planned status with a command, test, or real runtime output. Unsupported provider capabilities stay visible with a stable reason.

## Managed skills: CLI checkpoint (2026-10-26)

On the `codex/plugin-management-closure` branch:

```sh
node bin/ai-home.js skill install assets/provider-skills/aih-demo --provider claude --json
node bin/ai-home.js skill list --provider claude --json
node bin/ai-home.js skill disable aih-demo --provider claude --json
node bin/ai-home.js skill enable aih-demo --provider claude --json
node bin/ai-home.js skill doctor --provider claude --json
node bin/ai-home.js skill remove aih-demo --provider claude --json
```

`install` enables immediately; `--all-supported` selects all declared projection
adapters, even if their native executable is absent. This is a projection operation,
not evidence of native execution. Without `--provider`, enable/disable/remove act
on the selected skill's existing installations. Each provider result is returned,
and a partial failure yields exit 1. All actions support `--help`.

Skill resources follow the existing host-shared storage policy; account launches
reuse those resources. There is no account-private skill override in this checkpoint.
Native directories are used for Codex/Claude and declared CodeBuddy-family entries;
OpenCode and AGY use managed instruction blocks. Unmodified legacy `aih-collab`
symlinks/copies/blocks are adopted; foreign or edited content is preserved. Explicit
CLI disable/remove survives subsequent launch reconciliation. `skillInject=0`
continues to disable the resource through the same manager.

Validation: 22 tests passed across skill-manager, skill-command, native-resource-
registry and native-resource-management, including a subprocess invoking the real
AIH CLI with an isolated home. `aih skill --help` and `aih skill doctor --json`
exit 0. These checks establish management and projection, not real model use.
Native use probes are still being added; Task 4 is not complete yet.
