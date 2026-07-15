# 2026-06-30 Mobile PWA Strict Slash Closure

目标：把 mobile/PWA existing-node smoke 从“slash 失败也可接受”的历史诊断口径收敛为真实产品闭环：start、message、message completion、slash `/status`、stop 全部必须真实成功。

约束：

- 只使用 AWS current：`http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- 只使用默认端口 `9527`
- 不使用 mock 数据
- 不上传本地 provider 凭据
- 不碰旧服务器

## 1. Product Fix

变更：

- `scripts/fabric-real-mobile-pwa-session-smoke.js`
  - 删除 `--allow-unsupported-slash`，`headless_session_slash_unsupported` 不再能让 smoke 通过。
  - slash 命令现在必须返回 HTTP `200` 且 result `type=slash`。
  - marker prompt 改为要求输出精确 marker，避免模型自由发挥导致业务已跑但 marker 不可匹配。
  - message marker 命中后继续等待 child run `completed=true`，再发 `/status`，避免在 headless child run 仍 running 时触发 `409 headless_session_run_still_running`。
  - browser evaluate watchdog 返回后清理 timer，避免 JSON 已输出但进程继续挂住。
- `test/fabric-real-mobile-pwa-session-smoke.test.js`
  - 新增/调整断言：unsupported slash 必须失败。
  - current-node child run 先返回 marker/running，再返回 done/completed，锁定“slash 前必须等 completed”的流程。

## 2. Real Failure Ledger

### 2.1 `start_marker_not_found`

真实失败：

```text
runId=90aff767-af60-4b06-acba-93f487ea1734
failureStage=start_marker
failureReason=start_marker_not_found
events=ready:1,session-created:1,result:1,done:1,aborted:1
terminalTail=""
```

原因：

- 旧 prompt 要求模型拼接字符串，未包含精确 marker。
- 真实 opencode 结果没有产生可匹配 marker，浏览器和 RPC 链路其实已通。
- 该轮还暴露 browser evaluate watchdog 没有清理 timer，JSON 已输出后进程仍会多挂一段时间。

修复：

- prompt 改成精确输出 marker。
- evaluate 完成或失败后清理 watchdog timer。

### 2.2 `headless_session_run_still_running`

真实失败：

```text
parentRunId=0f71a20f-7bc2-4a48-b83e-319ac7764873
childRunId=f450ad33-9b29-4ade-b045-76464b0f1a19
sessionRef=ses_0e964823cffegYf3gYCTFhObkt
markers.start=true
markers.message=true
slash.status=409
slash.error=headless_session_run_still_running
```

原因：

- smoke 在 message marker 出现后立刻发 `/status`。
- 当时 child run 已有 `delta/result`，但还没 `done/completed`。
- 服务端正确拒绝对 still-running headless run 做 completed-run slash resume。

修复：

- message marker 后增加 `waitForCompletion()`，只有 child run completed 后才发 slash。

### 2.3 False Positive Slash Pass

历史问题：

```text
--allow-unsupported-slash
slash.status=400
slash.error=headless_session_slash_unsupported
ok=true
```

原因：

- smoke 还停留在旧诊断阶段，把 slash capability gap 当成可接受结果。
- completed-run slash 已经由 `2026-06-30-headless-slash-real-closure.md` 修复为真实可用，这个兼容开关会制造假通过。

修复：

- 删除 `--allow-unsupported-slash`。
- focused test 固定 `headless_session_slash_unsupported` 必须返回 `ok=false/failureStage=slash_command`。

## 3. Real Successful AWS Smoke

命令：

```bash
npx --yes --package playwright node scripts/fabric-real-mobile-pwa-session-smoke.js \
  --existing-node \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --client-endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --session-provider "opencode" \
  --session-account "1" \
  --session-model "" \
  --session-project "/home/ubuntu/aih-fabric-current" \
  --timeout-ms 60000 \
  --session-timeout-ms 60000
```

结果：

```text
ok=true
mode=mobile-pwa-existing-node
deviceInviteId=device-invite-wovyn_sunsm
parentRunId=1c997586-5cbd-4901-924a-8e012db54368
childRunId=dd3161f8-1c04-4da4-812b-28fe88184ceb
sessionRef=ses_0e96298cbffeZ7b12iU6fy5V4Z
markers.start=true
markers.message=true
messageCompletion.completed=true
slash.status=200
slash.command=/status
slash.unsupported=false
stop.status=200
final.completed=true
eventCounts=ready:1,session-created:1,delta:2,result:2,done:2,aborted:1
browser.consoleErrors=0
terminalTail contains AIH_MOBILE_PWA_START_OK_20260628 and AIH_MOBILE_PWA_MESSAGE_OK_20260628
```

AWS readiness before/after focused validation:

```text
/readyz ok=true ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

## 4. Verification

Local:

```text
node --check scripts/fabric-real-mobile-pwa-session-smoke.js
node --test test/fabric-real-mobile-pwa-session-smoke.test.js
  tests 7, pass 7
node --test test/playwright-require.test.js test/fabric-real-mobile-pwa-session-smoke.test.js
  tests 9, pass 9
node --test test/control-plane-device-session-command.test.js test/control-plane-device-session-start.test.js test/native-session-chat.test.js
  tests 65, pass 65
npm test
  tests 2904, pass 2904
```

AWS current:

```text
node --check scripts/fabric-real-mobile-pwa-session-smoke.js
node --test test/fabric-real-mobile-pwa-session-smoke.test.js
  tests 7, pass 7
```

## 5. Anti-loop Rules

- `browser_evaluate_timeout` 不是根因，必须先看 `failureStage/requestLog/consoleTail/networkTail`。
- start/message marker 不命中时，优先核对远端 run 事件内容，不要先归因到网络。
- completed-run slash 前必须确认 message child run `completed=true`。
- `headless_session_slash_unsupported` 在当前产品口径下必须失败，不能作为 ok=true 的兼容路径。
- JSON 已输出但命令还不退出时，优先检查未清理的 timer/handle。
