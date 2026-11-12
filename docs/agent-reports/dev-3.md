# dev-3：WebUI 模型缓存切换到 Go account_models（只读分析）

日期：2026-11-05
范围：`webui-openai-model-routes.js`、`webui-project-routes.js`、`webui-model-cache.js`、`provider-model-discovery.js`、Go `account_models` 读写链、`go-account-sync`
约束：只读分析 + 文档；未改代码，未提交，未重启服务

## 交付物

- 新增：`docs/plans/2026-11-06-webui-model-cache-go.md`（方案，约 800 行）
- 报告：本文件

## 完成内容

方案覆盖用户要求的五项：

1. **现状调用链**：前端三个入口 → `/v0/webui/openai-models` / `/v0/webui/models` → `handleGetOpenAIModelsRequest` / `handleGetModelsRequest` → `getWebUiModelsCache` → Node 快照 / 探测 → `buildModelEntrySets` / `buildManagedModelItems` / `buildModelAccountRefProjection`；以及 Go 侧 `account_models` 的写入、读取、重扫、首次恢复、路由索引。
2. **精确切换点**：三个读入口（`webui-openai-model-routes.js:607`、`:881`、`webui-project-routes.js:182`）+ 三个写入口（`:673/721/774`）+ 全局刷新（`:1014`）；新增 `webui-model-catalog-go.js` 适配器，替换 `catalogResult` 生产者，下游纯函数不动。
3. **缓存失效策略**：Go 真值 + Node 短 TTL 投影 + 3 秒 HTTP 响应缓存 + 首屏持久化投影；事件矩阵覆盖写模型、刷新、账号启停/导入/删除、凭据失效、Go 后台重扫、Go 不可用；回滚用 `modelCatalogSource`。
4. **回归风险**：P0 5 项、P1 11 项、P2 4 项；每项带证据、缓解、守卫。
5. **分步验证命令**：基线测试、ref 映射脚本、Go 存储查询、Go API 契约测试、Node 投影单测、真机读路径、write-through、ETag、重启/回滚、双读门禁。

## 关键实测发现（只读，2026-11-05 18:48 左右）

数据源：`~/.ai_home/aih.db`、`~/.ai_home/app-state.db` 的 `cache:webui-models-snapshot.json`。

| 发现 | 数字 | 影响 |
| --- | --- | --- |
| Node/Go 账号身份 | 43 / 43，5 个 ref 不同 | 直接拿 Go ref 当页面 key 会丢 5 个账号；必须用 `go-account-sync:state.links` 映射 |
| 模型集合一致的账号 | 29/43 | 大部分可平滑切换 |
| Go 领先 | 13 个账号，+92 个模型（agy 6×12、cline 2×2、zcode 12+4×1） | Go 保留了停用账号目录，符合 WebUI 全量管理口径 |
| Node 领先 | 1 个 opencode 账号，−41 个 `opencode/*` | 单腿（Zen）失败被当成完整目录；已由并发提交 `75eda502` 改为 fail-closed，存量行需一次成功刷新回填 |
| Go 无模型行 | 4 个账号：2 个停用 claude/gemini，2 个 enabled zcode | zcode 日志持续报 `zcode 模型目录为空`，需要探测事实表把日志变成 UI 可读字段 |
| 总量差 | 680 = 629 − 41 + 92 | 差异可完全解释 |

## 并发变更（工作期间发生）

- `75eda502`（2026-11-05 19:08）由另一并发任务提交，包含：
  1. opencode 模型发现改为「两条腿都成功才算完整」，单腿失败直接报错、保留旧行；
  2. 本方案文件被该提交一并纳入（本 agent 未执行 `git add` / `git commit`）。
- 因此方案里的 P0-4 标记为「已关闭」，但本机 `account_models` 的 opencode 账号仍是修复前的 68 行；需要一次成功刷新才会回填到 109+。
- 其余四项 P0（ref 映射、批量端点、探测事实表、generation）仍未落地。

## 主要结论

1. **不能把 `getWebUiModelsCache` 直接改成读 Go**：它同时服务别名校验、请求路径探测、`/v1/models`、CLI 补全、Claude harness；爆炸半径远超 WebUI。
2. **不能只切管理页**：`/v0/webui/openai-models` 与 `/v0/webui/models` 必须同源，否则模型页与会话选择器会不一致。
3. **Go 侧要先补五件事**：批量读端点、探测事实表（last_attempt/last_error/last_model_count/source）、目录 generation、opencode incomplete 语义、Node→Go ref 映射。
4. **Phase 1 保留 Node 探测**：Node 快照继续服务路由/CLI/别名；WebUI 管理面先切 Go，双读通过后再切默认值。
5. **首屏不能阻塞**：启动时加载持久化投影，请求路径只读本地投影 + 后台条件 GET；这与现有「列表先出内容再异步补数据」的约束一致。

## 运行/检查记录

只读命令：

```bash
git status --short
git rev-parse --short HEAD
sqlite3 "file:$HOME/.ai_home/aih.db?mode=ro" "select count(*), sum(enabled) from accounts;"
sqlite3 "file:$HOME/.ai_home/aih.db?mode=ro" "select count(*), count(distinct account_ref), sum(upstream_available) from account_models;"
node <<'EOF'  # 按 links 映射后逐账号比较 Node 快照与 Go 行（脚本见方案 §5 Step 1）
...
EOF
grep '账号模型刷新' "$HOME/.ai_home/logs/go-core.log" | tail -20
```

未运行 `go test` / `node --test` / 构建 / 重启：本任务要求只读分析，且验证命令已写入方案供实施阶段执行。

## 改动清单

```text
M  docs/plans/2026-11-06-webui-model-cache-go.md   # 18+/13-：同步 opencode 并发修复、补充 AIH_* 约束等
?? docs/agent-reports/dev-3.md
```

说明：本 agent 没有执行 `git add` / `git commit`。方案文件写入后，被另一并发任务一并提交到 `75eda502`（提交信息同时包含 opencode 双腿完整性修复）；当前工作区只剩上述未提交改动。仓库中其余未提交改动来自其它并行任务，未触碰。

## 待拍板（详见方案 §7）

1. 展示口径：严格 Go 可路由集合，还是 Go ∪ Node `availableModels`/descriptors？推荐前者。
2. 删除账号目录是否要在 Go 加墓碑留档？推荐 Phase 1 继续用 Node retained。
3. 是否允许 Go 对 `enabled=0` 账号做低频发现？推荐允许。
4. 一个 Go 账号映射多个 Node 账号时是否合并展示？推荐 fan-out + 标「共享身份」。
5. `cached` 语义是否保留「刚刷新 false、普通 GET true」？推荐保留。
