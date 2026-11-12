# dev-2：状态事件日志与双读回放的边界测试

日期：2026-11-05
范围：`lib/server/status-event-journal.js`、`scripts/status-dual-read-replay.js`
约束：只新增 `test/status-journal-edge.test.js`，未改实现，未提交。

## 交付物

- 新增：`test/status-journal-edge.test.js`（6 个用例）
- 报告：本文件

## 覆盖矩阵

| 要求 | 用例 | 关键断言 |
| --- | --- | --- |
| 5MiB 轮转 | `默认 5MiB 上限：跨阈值轮转，且只保留一份 .1 旧档` | `DEFAULT_MAX_BYTES === 5 * 1024 * 1024`；三批 4KB 事件，首批不轮转，跨阈值后主文件 rename 成 `.1`；第二次轮转覆盖 `.1` 而非新增；目录内只有主文件与一份旧档；两份文件仍可逐行 JSON 解析 |
| 禁用时零副作用 | `未启用 / 禁用后 append 零副作用：不建目录、不写文件、不抛错` | 未启用时 `append/null/flush/disable` 全部返回 false，不创建 `observability/`；非法 `enable` 参数不留痕；`disable()` 后再次 append 不改变旧文件大小 |
| 非法行跳过 | `readJournal 逐行跳过非法记录：坏行报行号，合法事件不受影响` | 半行 JSON、非对象、版本 2、负 atMs、缺 accountRef/provider、未知 op、failure 缺负载、clear 缺 evidence、`null` 共 10 条坏行逐行记录正确行号；空行不报错；合法事件（含 state 缺省与显式 null 的区别）全部保留 |
| replay 空 journal | `空 journal：replay 正常结束，零账号零分歧零错误` | 空白文件退出码 0；JSON 报告 accounts/steps/divergences/errors/truncations 全空；人类可读输出为「日志为空，无事件可比对」 |
| 单账号超 200 步截断 | `单账号超过 200 步：按 atMs 稳定排序后保留最早 200 步` | 250 条乱序事件先按 atMs 排序再截断，保留最早 200 步（from/to 正确，dropped=50）；`buildRequest` 实际只带 200 步；未超限账号不受影响 |
| 注入假 oracle 检出分歧 | `注入假 oracle：多字段分歧与 results.length 分歧都能被检出` | 同时篡改 status 与 runtimeState 时一次运行报出 `status`、`runtimeState.injected` 两处；无 `--fail-on-divergence` 时退出码仍为 0；oracle 少返回一条结果时报 `results.length`（step 0，node=2/go=1），且 errors 为空 |

## 运行结果

```
$ node --test test/status-journal-edge.test.js
✔ 6/6 pass，0 fail（约 4.5s）
```

同模块既有测试回归：

```
$ node --test test/status-event-journal.test.js test/status-dual-read-replay.test.js test/status-dual-read-fixture.test.js
# tests 16 / pass 16 / fail 0
```

## 实现侧观察（未改动）

1. **空 journal 是提前返回**：`main()` 在 `journal.empty` 分支直接输出「日志为空，无事件可比对」并返回，不打印常规的 `accounts=... steps=...` 汇总行。测试据此断言该专属文案，而不是汇总行。
2. **轮转只保留一代旧档**：`.1` 是覆盖式 rename，符合文件头注释的取舍；测试用第二批事件的 atMs 验证 `.1` 内容确实来自上一轮，而不是更早的历史。
3. **超限单批会被裁剪**：`fitLatestLines` 只保留最新的、放得下的一部分。本组用例按「多批跨阈值」构造，不触发该分支；该分支属于另一条边界（单批 > maxBytes），本次未覆盖。
4. **截断顺序**：`splitAccounts` 先稳定排序再 `slice(0, 200)`，保留最早的一段，与注释一致。

## 改动清单

`git status` 中本次只新增 `test/status-journal-edge.test.js` 与 `docs/agent-reports/dev-2.md`；仓库里其余 Go 文件改动来自其它并行任务，未触碰。
