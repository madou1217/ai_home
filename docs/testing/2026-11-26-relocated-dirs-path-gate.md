# relocated-dirs 路径门（2026-11-26）

## 目的

`relocated-dirs` 在 ubuntu / macOS / windows 三平台运行 `internal/sessionscan` 测试。
macOS arm64 托管 runner 容量紧张，曾出现排队约 15 分钟后仍未获取 runner 的 cancelled。
纯文档等无关改动不应占用三平台 runner。

## 实现

- 新增 `relocated_scope` job（ubuntu），输出 `run`。
- 触发名单从 `go list -deps -test ./internal/sessionscan/...` 的仓库内依赖闭包派生，
  当前为 28 个目录根；另加 `go.mod`、`go.sum`、`.github/workflows/go-tests.yml`。
- `relocated-dirs` 使用 `needs` + job 级 `if`：`run=false` 时整个三平台矩阵跳过。
- 安全兜底：无可用 base、diff 失败、依赖解析失败时一律 `run=true`。
- GitHub 语义：skipped job 按 Success 计，不会阻塞 required check；main 当前未启用分支保护。

## 本地验证

用真实提交 diff 执行 workflow 中的同一段脚本：

| 场景 | 结果 |
| --- | --- |
| 仅 `docs/` 变更（`3a186822`） | `run=false` |
| `internal/sessionscan` 变更 | `run=true` |
| `core/accounts` 依赖变更 | `run=true` |
| `go.mod` 变更 | `run=true` |
| 本工作流变更 | `run=true` |
| base 为全零 / 未知 | `run=true` |

## 线上验证

- docs-only 提交 `6fb094a5`（仅新增本文档），run `45753525541`；
- `relocated dirs scope` 日志：
  - changed files: `docs/testing/2026-11-26-relocated-dirs-path-gate.md`
  - dependency roots: 28
  - `relocated-dirs tests needed: false`
- `relocated dirs (${{ matrix.os }})` 结论 `skipped`，`runner=None`，`steps=0`，
  没有申请任何平台 runner；
- go-tests 整体 success。

注意：job 级跳过时 matrix 尚未展开，check 名称是
`relocated dirs (${{ matrix.os }})`。main 当前没有分支保护；如果以后把逐平台
check 配成 required，需要重新评估这个门。
