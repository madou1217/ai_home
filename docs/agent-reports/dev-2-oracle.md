# dev-2：双读回放的真实 oracle 集成测试

日期：2026-11-05
范围：\`scripts/status-dual-read-replay.js\` + \`cmd/status-oracle\`
约束：只新增测试文件，未改实现，未提交。

## 交付物

- 新增：\`test/status-dual-read-replay-oracle.test.js\`（2 个用例）
- 报告：本文件

## 测试设计

### 固定 journal

临时目录写入 \`status-events.jsonl\`，2 个账号共 6 步，三种 op 都覆盖：

| 账号 | 步骤 | op |
| --- | --- | --- |
| \`acct_0123456789abcdef0123\` | 1 | \`failure\` auth_invalid / 300s |
| 同上 | 2 | \`clear\` login_success |
| 同上 | 3 | \`failure\` rate_limited / 60s |
| \`acct_0123456789abcdef0456\` | 1 | \`failure\` overloaded / 30s |
| 同上 | 2 | \`runtime_state\`（完整 Node 文档，rateLimitUntil 在未来） |
| 同上 | 3 | \`clear\` upstream_success |

\`runtime_state\` 故意用完整文档而不是 \`null\`，让比对覆盖字段级映射（空 map、零值时间桶、
routingBlock 等），而不是只比一个「清空」。

### 真实 oracle 路径

- 用例 1 不传 \`--oracle\`，直接走脚本默认的 \`go run ./cmd/status-oracle\`；
- 子进程由 \`child_process.spawnSync\` 启动，\`cwd\` 固定仓库根，\`timeout=120_000\`；
- 启动前用 \`go version\` 探测工具链，缺失时整组 test 标记 skip（Node-only 环境不误判为红）。

断言：退出码 0，\`accounts=2\`、\`steps=6\`、\`divergences=[]\`、\`errors=[]\`、\`truncations=[]\`。

### 篡改注入

用例 2 生成一个临时包装脚本作为 \`--oracle\`：

1. 以 \`process.cwd()\`（即仓库根）spawn 真实 \`go run ./cmd/status-oracle\`；
2. 缓冲真实 oracle 的 stdout，等子进程结束后按行解析；
3. 只改第一行响应的第一个结果：
   - \`status = 'tampered'\`
   - \`runtimeState.authInvalidUntil += 1\`
4. 其余行原样输出，子进程退出码原样透传。

缓冲后再改写而不是流式 readline：初版流式实现会在子进程 close 后丢最后一行，导致
被测脚本报「oracle 未返回响应」而拿不到分歧；改成 close 后一次性处理才稳定。

断言：退出码 1（\`--fail-on-divergence\`），\`accounts=2\`、\`steps=6\`、\`errors=[]\`，且：

- 分歧恰好 2 条；
- 全部落在 \`acct_...0123\`，账号 B 零分歧（证明只篡改了一行）；
- \`status\` 分歧在 step 1，\`go='tampered'\`、\`node!='tampered'\`；
- \`runtimeState.authInvalidUntil\` 分歧满足 \`go = node + 1\`，证明嵌套字段真的在比。

## 运行结果

\`\`\`
$ node --test test/status-dual-read-replay-oracle.test.js
✔ 真实 Go oracle：2 账号 6 步逐字段一致 (≈0.37s)
✔ 真实 Go oracle 输出被篡改：定位到账号、步骤与字段 (≈0.13s)
# tests 2 / pass 2 / fail 0 / skipped 0
\`\`\`

相关测试回归（假 oracle、夹具、journal、边界）：

\`\`\`
$ node --test test/status-dual-read-replay.test.js test/status-dual-read-fixture.test.js \
    test/status-event-journal.test.js test/status-journal-edge.test.js
# tests 22 / pass 22 / fail 0
\`\`\`

实际耗时远低于 120s（Go 构建缓存命中时单次 \`go run\` 约 0.1–0.4s），超时值只作兜底。

## 结论与备注

- 真实 Go oracle 与 Node 回放在这 6 步上逐字段一致，§7-d 双读链路闭环成立。
- 注入 \`status\` 与嵌套 \`runtimeState\` 各一处偏差后，脚本能精确报出账号、步骤和字段，
  且不会把未篡改账号牵连进来。
- 本用例依赖 Go 工具链；\`go run\` 首次编译可能超过 1s，但受 120s 上限保护。
- 工作区中的其它改动来自并行任务；本次只新增测试文件与报告，未改实现、未 commit。
