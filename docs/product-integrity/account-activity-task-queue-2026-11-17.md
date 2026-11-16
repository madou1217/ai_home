# 账号活动任务队列字段修复与真实验收

## 范围与问题

- 本次会话：`01a1e515-e6f3-7843-8b0e-955b8463e8f3`。
- 用户在后台任务队列看到「全部 1 / 安装卸载 0 / 账号活动 1」，卡片标题却为 `undefined CLI 安装`。
- 2026-11-17 00:03 左右（UTC+8），使用现有 Microsoft Edge、Playwright extension 连接原页面 `http://127.0.0.1:9527/ui/accounts`，确认原样复现；没有 AppleScript、浏览器切换或新启动浏览器。
- 实际原任务是 ZCode「领臭鸡蛋」；GET 活动 job 返回 `succeeded`、`completed=10 / total=10`。本次没有重新执行该真实领取任务。

## 根因与归属证据

1. Go `internal/runtime/taskhub/adapters.go` 在快照和增量事件中直接 JSON 化 `accountactivity.JobView`。该结构有 `providers`、`actionLabel`，没有统一 UI 所需 `provider`、`appId`、`taskName`、`kind`、`action`、`progress.label`。
2. `AppInstallTaskQueue` 按 `source=account-activity` 正确计数，但原 `taskName()` 只区分 terminal/desktop，其他类型全部兜底成 CLI 安装；两个单值身份字段均缺失，就生成了 `undefined CLI 安装`。
3. 同一字段遗漏也导致动作显示「后台操作」、来源显示「应用」、已完成 10/10 的进度说明却显示「等待状态更新」。不是上游真的执行了 CLI 安装。
4. 该 Go 实现引入提交为 `e6847f368143e5d523d4c69ebc9c0335e63ac1ad`，2026-11-13 13:55:34 +08:00，`feat(ops-misc): 计划任务、任务中心、Codex 重置卡、密钥轮换与服务重启迁移至 Go`。提交版本的 adapters.go:64、76 分别为原始 StructToTask/PublishTyped。
5. 确认改过旧 Node mapper 的相关会话：CodeBuddy 家族 `01a18e3b-02fa-710e-811a-56a6d79724b6`。2026-10-31 12:06:52 +08:00 将 `error` 改为优先 `errorSummary`，属于失败归因展示。证据为本机 `.codebuddy/projects/Users-model-projects-feature-ai_home/<session>.jsonl` 的第 86（需求）、310（Edit）、312（成功）行。不能因此认定该会话编写了 Go 回归。
6. 本次有界查询没有找到该 Go 提交的原作者会话写入记录。11/14 的 `01a1da37-65e3-79c1-84c2-c4c66fe9f431`、`01a1da37-66aa-7fa0-8899-6693b5deaa40` 是后续只读审查子会话，不是作者。

## 修复

- Go：聚焦活动 adapter 输出统一任务投影；REST 快照和 SSE 增量共用同一函数，保留活动原始结果，补齐标题、种类、动作、目标、进度文案，错误优先用人类可读归因。
- Node 兼容代理：补齐 source、标题及活动元数据，不恢复任何活动执行回退。
- WebUI：按 kind/source 统一识别活动，兼容旧原始事件；未知种类不冒充 CLI；正确显示活动名称、动作、来源。
- `partial` 识别为「部分成功」终态，保留失败详情；终态中性进度条不再播放 active 动画。
- 不修改活动执行器、账号数据、安装执行行为、队列交互布局或 CSS；未新增或修改测试用例。

## 构建与检查

验证候选使用 `297a08c086707cef3a589b5e469a59405eb4f759` 的 git archive 加本次明确路径补丁；临时归档不是 git worktree/branch。共享目录的 Chat/终端未提交变更没有打入私有候选。

- `go build ./internal/runtime/taskhub ./internal/transport/http/webuitasksapi`：通过。
- 对相同两个包 `go vet`：通过。
- 隔离归档 `go build -trimpath -o /tmp/aih-task-queue-20261117/aih-server ./cmd/aih-server`：通过。
- `node --check lib/server/webui-account-activity-routes.js`：通过。
- 五个源码的 `git diff --check`、三个 WebUI 文件的 ESLint：通过。
- Node 22.21.0、独立归档的 Umi production build：通过。Node 26 在 Umi 依赖中缺 `http_parser`，使用已安装的 Node 22 修正构建环境，没有修改依赖或产品配置。
- TypeScript 全量检查未通过：生成 Umi 文件后仍有三条控制面既有错误（active-control-plane.ts:218；control-plane-profiles.ts:1306、1316）。同一隔离环境临时还原本次三个 WebUI 源码到基线重跑，三条诊断完全一致；随后恢复候选源码。不能声称全项目类型检查通过。

## 真实业务接口验收

- 私有服务：`http://127.0.0.1:19147`，隔离 HOME / AIH_HOME_DIR，随机独立凭据，没有导入任何真实账号。未重启、替换或发布共享 9527。
- 使用真实 `POST /v0/webui/accounts/activity/run`、`GET /v0/webui/tasks`、`GET /v0/webui/tasks/watch`、GET 活动 job。
- 选择 200 个隔离环境内不存在的 ZCode 账号；返回 202。原服务真实完成账号不存在分支，全部 `account_not_found`，不触发 provider 上游。
- 同一任务收到 **404** 条真实 SSE task 事件，轮询捕获 **22** 次非空 REST 活跃快照。
- 每个事件及快照均为 `taskName=zcode 领臭鸡蛋`、`kind=activity`、`source=account-activity`、`provider/appId=zcode`；进度文案从 `0/200` 到 `200/200`，终态 failed 正确。
- 独立验证结果：`/tmp/aih-task-queue-20261117/real-api-result.json`。该验证仅证明队列字段/传输与账号不存在失败链路，不声称真实领取成功。

## 真实桌面页面验收

- 复用现有 Edge 标签页，在临时 iframe 加载私有服务的完整生产构建；桌面尺寸 1912×805，没有主动聚焦浏览器或新窗口。私有目标创建 CDP 被扩展拒绝后，没有切换浏览器或使用 Apple Events。
- 私有页面真实发起 10 个不存在账号的任务，经过真实 SSE 到 UI；显示 `zcode 领臭鸡蛋`、动作「领臭鸡蛋」、来源「账号活动」、`10/10`、执行失败。
- 页签实测：全部 1、账号活动显示 1 张、安装卸载显示 0 张。
- 真实点击展开失败详情，显示「全部 10 个账号失败：account_not_found ×10」。
- DOM 检查零 Alert、零粗左侧装饰边；已实际查看完整页面截图。
- 证据：`/tmp/aih-task-queue-20261117/{before.png,after.png,after-expanded.png,edge-final-result.txt}`。未进行 mobile 验收。

## 审查与交付边界

- 独立 reviewer 会话 `01a1e51d-913e-7623-824b-e2bda762d6e1` 对五个源码 live diff 审查；初审无阻塞，三个非阻塞兼容/终态建议均已收敛；最终 live diff 复审 checkpoint gate 为 YES，不构成部署授权。
- 本次只提交自己的明确路径，使用独立临时 index，提交前后检查主 index 及非本次路径的暂存字节，不夹带或退回其他会话代码。
- 本次验证对象是私有候选，不代表共享 9527 已部署，也不代表全量项目类型检查通过。共享服务重启/上线需要单独授权与验收。
- 清理：本会话临时 iframe 已移除，Playwright 仅 detach（未关闭浏览器），19147 私有进程已按精确 PID/命令核对后正常终止；9527 仍监听。
