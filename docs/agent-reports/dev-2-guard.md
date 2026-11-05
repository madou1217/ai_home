# dev-2：设计守卫测试

日期：2026-11-05
范围：\`lib/providers/quota-ownership.js\`、\`lib/server/go-core-sync-facade.js\`、\`lib/providers/defs/\`
约束：只新增测试文件，未改实现，未提交。

## 交付物

- 新增：\`test/design-pattern-guard.test.js\`（3 个用例）
- 报告：本文件

## 三类不变量

### 1. 额度归属表 ↔ descriptor.quota.supported

- 正向：\`GO_QUOTA_OWNERS\` 里每个 Provider 都必须有 descriptor，且 \`capabilities.quota\`
  与 \`goOwnedQuota(id)\` **逐字段 deepEqual**、\`supported === false\`、reason 含「Go 采集」。
  用 deepEqual 而不是正则，是为了防止有人手写一份看起来一样的 \`supported/reason\`，
  绕过 \`goOwnedQuota()\` 这个唯一派生入口。
- 反向：
  - \`supported: true\` 的 Provider 不能出现在表里；
  - \`supported: false\` 必须给出 reason；
  - reason 声称「Go 采集」的 Provider 必须登记在表里（禁止手写 false 绕过归属表）。
- \`isGoOwnedQuota(id)\` 与表成员关系逐项一致。
- \`opencode\` 这类「上游没有额度接口」的 \`supported:false\` 仍合法，只要 reason 说明原因。

### 2. FACADE_METHODS ↔ createGoCoreHost 返回值

- 直接 require \`lib/server/go-core-host.js\`，用内存替身构造宿主：
  - \`settings.enabled=false\`，不启动子进程、不建账号同步、不挂定时器；
  - 注入假 \`createGoCoreSupervisor\`（并断言 \`start()\` 从未被调用）；
  - 注入假 \`createGoCoreGatewayForwarder\`；
  - 注入 \`manifest={entries:[]}\`，避免读真实路由清单。
- 断言 \`FACADE_METHODS\` 每项在宿主返回对象上都是函数；再用真实宿主调用
  \`createGoCoreSyncFacade(host)\`，断言暴露面严格等于清单且已冻结。
- 不启动 Go 服务、不监听端口、不写文件。

### 3. defs 下 id 唯一性

- provider id：\`lib/providers/defs/*.js\` 导出的 16 个 descriptor 中全局唯一；
- 策略 id：遍历 \`capabilities.*.strategies\`，同一 capability 内唯一，且全局唯一
  （当前 31 条 model/quota 策略全部通过）；
- 非 descriptor 辅助模块（如 \`config-*.js\`）按「无 id」跳过；
- \`activity.actions\` 的 id 是动作名而非策略 id：\`qoder\` / \`qodercn\` 有意共用
  \`daily_checkin\`（同一签到接口、区域主机不同），因此不纳入全局唯一性检查，已在注释中说明。

## 运行结果

\`\`\`
$ node --test test/design-pattern-guard.test.js
✔ 额度归属表与 descriptor 的 quota.supported 双向一致
✔ FACADE_METHODS 全部存在于真实 createGoCoreHost 返回值
✔ defs 下 provider id 与策略 id 均无重复
# tests 3 / pass 3 / fail 0
\`\`\`

相关既有测试回归：

\`\`\`
$ node --test test/design-pattern-guard.test.js test/quota-ownership.test.js test/go-core-sync-facade.test.js
# tests 14 / pass 14 / fail 0
\`\`\`

## 守卫有效性证明（变异测试）

用 \`node --require\` 预加载临时脚本修改 require 缓存，再跑本测试；四个变异都让对应守卫变红，
证明断言不是空转：

| 注入的破坏 | 变红的用例 |
| --- | --- |
| 把 \`agy\` 的 quota 改成 \`{ supported: true }\` | 用例 1 |
| 把 \`codex.id\` 改成 \`agy\` | 用例 1、用例 3 |
| 把 \`agy\` 的 models 策略 id 改成 \`codex-http\`（跨 Provider 重名） | 用例 3 |
| 包装 \`createGoCoreHost\` 并删掉 \`exportAccounts\` | 用例 2 |

临时预加载脚本写在 \`/tmp\`，验证后已删除，未进入仓库。

## 备注

- 测试只做 require + 内存对象构造，不启动服务、不创建监听、不读用户目录。
- 工作区中的其它改动来自并行任务；本次只新增 \`test/design-pattern-guard.test.js\` 与本报告，
  未改实现、未 commit。
