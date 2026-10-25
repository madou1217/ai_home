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
