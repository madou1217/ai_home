# WebSocket 账号级 401/403 换号真机验收清单

日期：2026-11-23（Asia/Shanghai）
适用改动：`5fa01ece fix(ws): switch accounts when the handshake credential is rejected`
适用范围：Codex Responses WebSocket 握手阶段，钉选账号或池内候选账号返回 401/403。

## 1. 验收目标

1. 钉选账号在握手阶段返回账号级 401/403 时，客户端**不应**直接收到 401：
   该账号进入本轮排除集，继续尝试池内其它健康账号。
2. 同一请求最终返回 `response.completed`，且用量记到实际服务的健康账号。
3. 池内没有健康账号时，必须在有限时间内终止并返回真实 401/403，不能死循环。
4. 503、超时、断连等非凭据故障仍保持单次握手语义，不因本次放宽而升级为全池重试。
5. 证据中不得出现 token、Authorization 头或凭据正文。

## 2. 前置条件

- 一台可操作的测试 Server（AWS 或本地），已启用 Codex 网关模式；
- 至少两个 Codex 账号，属于同一 Provider/模型池：
  - `A`：可丢弃的 api-key 账号，用来制造 401/403；
  - `B`：健康账号，用来承接换号后的请求；
- `A` 与 `B` 都物化了目标模型 `<model>`；
- 可用管理密钥和客户端 API Key；
- 本机有 `wscat`；没有时可用 `aih codex relay <A-ref>` 作为驱动；
- 记录 Server 的插件数据根（用于读取 `run/route-observation`）。

## 3. 基线记录

```sh
export AIH_SERVER_BASE_URL='http://127.0.0.1:9527'
export AIH_SERVER_MANAGEMENT_KEY='<management-key>'
export CLIENT_KEY='<client-api-key>'

aih account list --json > /tmp/acc-before.json
aih account show <A-ref> --json > /tmp/acc-a-before.json
aih account show <B-ref> --json > /tmp/acc-b-before.json
aih account models list <A-ref> | grep '<model>'
aih account models list <B-ref> | grep '<model>'
aih account usage show <B-ref> --json > /tmp/usage-b-before.json
```

通过标准：

- `A`、`B` 都存在且已启用；
- 两个账号的模型目录都包含 `<model>`；
- 记录 `B` 的最近用量，供后续对比。

## 4. 制造账号级 401/403

优先使用可丢弃、原本健康且已物化 `<model>` 的 api-key 账号，并保管它的原 key；不要直接破坏真实 OAuth 账号。

```sh
OPENAI_API_KEY='sk-invalid-acceptance-only' \
  aih account credential update <A-ref> --from-env
```

先用非 WebSocket 请求确认 `A` 已经稳定返回 401/403：

```sh
curl -sS -o /tmp/a-probe.json -w '%{http_code}\n' \
  "$AIH_SERVER_BASE_URL/v1/responses" \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H "X-Account-Ref: <A-ref>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model>","input":"ping","stream":false}'
```

通过标准：HTTP 为 401 或 403；若仍是 200，说明账号未真正失效，停止后续步骤。

## 5. WebSocket 主路径

### 5.1 用 wscat 发起钉选请求

```sh
SESSION="acc-$(date +%Y%m%d%H%M%S)"
wscat -c "ws://127.0.0.1:9527/v1/responses" \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H "X-Account-Ref: <A-ref>" \
  -H "X-Session-Id: $SESSION"
```

连接建立后发送一条最小推理帧：

```json
{"type":"response.create","model":"<model>","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"reply with exactly ws-ok"}]}]}
```

通过标准：

- 连接没有被 401/403 立即关闭；
- 收到 `response.completed`，输出包含 `ws-ok`；
- 记录 `SESSION`，用于读取路由观测。

如果 wscat 握手本身被拒（400/426），说明客户端头不完整：改用下面的 Codex 驱动，不要把 wscat 的失败当成换号失败。

### 5.2 用 Codex CLI 驱动（备选）

```sh
aih codex relay <A-ref>
```

在 TUI 中输入：

```text
reply with exactly ws-ok
```

通过标准：TUI 正常返回 `ws-ok`，没有首轮 401/需要重连。
注意：该驱动必须确认走的是 WebSocket；若 Codex 回落到 HTTP，本用例不覆盖目标分支。

## 6. 取证

### 6.1 实际服务账号

在 Server 的数据根读取本轮路由观测：

```sh
cat "<server-ai-home>/run/route-observation/$SESSION.json"
```

通过标准：

- `accountRef` 等于 `<B-ref>`，不是 `<A-ref>`；
- `model` 等于 `<model>`。

### 6.2 用量归属

```sh
aih account usage show <B-ref> --json > /tmp/usage-b-after.json
aih account usage show <A-ref> --json > /tmp/usage-a-after.json
```

通过标准：

- `B` 的用量（token 或请求计数）增加；
- `A` 没有新增成功用量（失败探测不算成功）；
- 若使用 remote session，同一 `SESSION` 的详情也应记到 `B`。

### 6.3 连续稳定性

重复第 5 节 3 次，每次使用新的 `SESSION`。通过标准：3 次都返回 `ws-ok`，至少 2 次可从路由观测确认落到 `B`。

## 7. 负向用例

### 7.1 池内没有健康账号

1. 停用 `B` 以及其它可能承接请求的 Codex 账号；
2. 只保留失效的 `A`，重复第 5 节；
3. 记录开始与结束时间。

通过标准：

- 在有限时间内终止（建议不超过 30 秒）；
- 返回真实 401/403 或可读的凭据错误；
- 不出现无限重连、CPU 空转或重复撞同一账号。

完成后立即重新启用 `B`。

### 7.2 非凭据故障不得换号

使用一个可丢弃账号 `C`，把上游基地址指向不可达地址，或让上游返回 503：

```sh
# 若 C 尚未创建
OPENAI_API_KEY='sk-acceptance-c' \
OPENAI_BASE_URL='http://127.0.0.1:1' \
  aih account add codex --from-env

# 若 C 已存在
OPENAI_API_KEY='sk-acceptance-c' \
OPENAI_BASE_URL='http://127.0.0.1:1' \
  aih account credential update <C-ref> --from-env
```

`C` 也必须已物化 `<model>`，否则请求会在选号阶段失败，无法验证握手错误分类。若 `C` 无法物化模型，改用 `A`：恢复原 key，只把 base URL 改成不可达地址。

钉选 `C` 发起 WS 请求。通过标准：

- 请求在单次握手后终止；
- 不因池里有健康 `B` 就自动换号；
- 错误类型为连接失败/503，而不是 401/403。

该用例用于防止本次改动把「所有失败」都误判成可换号。

### 7.3 1011 重连分支（可选）

需要真实 429/配额耗尽才能触发「本轮尚未输出时可重试失败 → 1011 让 Codex 重连」。
若无法稳定构造，记录「未验证」，不要用代码阅读代替真机结论。

## 8. 清理

```sh
# 恢复 A 的真实凭据（仅当 A 是临时改坏的账号）
OPENAI_API_KEY='<original-key>' \
  aih account credential update <A-ref> --from-env

# 重新启用 B
aih account enable <B-ref>

# 删除临时账号 C（如创建）
aih account delete <C-ref> --yes

# 清理路由观测测试文件
rm -f "<server-ai-home>/run/route-observation/$SESSION.json"
```

注意：

- 不要删除 `account_usage` 历史行；它们是审计证据；
- 不要在证据文件里保存 Authorization 头、token 或完整凭据；
- 若 `A` 是真实账号且无法恢复原 key，改用可丢弃账号重新执行，不要留下失效的真实账号。

## 9. 通过标准汇总

| 检查项 | 必须通过 |
|---|---|
| 钉选账号 401/403 后客户端收到 `response.completed` | 是 |
| 路由观测显示实际服务账号为健康账号 | 是 |
| 健康账号用量增加、失效账号无成功用量 | 是 |
| 连续 3 次请求不出现首轮 401 | 是 |
| 全部账号失效时有限终止 | 是 |
| 503/连接失败不跨账号换号 | 是 |
| 证据不含凭据 | 是 |
| 1011 重连分支 | 已验证（2026-11-23） |

## 10. 已知覆盖边界

- `internal/transport/http/codexresponsesws` 没有自动化测试文件；
- 本清单是手工真机验收，不是 CI 回归；
- `rejectsCredential()` 的两个 RuntimeKind 分支、Phase 1 候选账号分支、全池失效分支，
  目前只能靠本清单和代码核对覆盖；
- 修改该文件后，至少重跑第 5、6、7.1、7.2 节。

## 11. 执行记录（2026-11-23，AWS）

环境：AWS Server + SSH 隧道 + 真实 WS 客户端；acct_97ed95c232eb87316477 是可丢弃的 api-key 账号，临时指向受控 WS 上游（对指定 key 返回 401/503）；acct_9aa145b7fcd69a60cd73 是真实健康账号。

结果：

- 401/403 主路径：3 次钉选失效账号，全部收到 response.completed 与 ws-ok；路由观测均落到健康账号 acct_9aa145b7fcd69a60cd73；
- 503 负向：钉选同一失效账号并让上游返回 503，客户端收到 upstream_unavailable，连接终止；没有产生路由观测，说明未换号；
- 用量归属：路由观测已确认实际服务账号；本次没有单独核对逐请求 token 行；
- 全池失效：未执行。AWS 是共享账号池，临时停用所有健康账号会影响其它会话；
- 1011 重连分支：通过两种变体。① upstream 在 response.created 后、尚未输出时断开（incomplete-stream）：客户端收到 CLOSE 1011 / reason=retryable upstream failure；② upstream 发送 response.created 后紧跟 type=error,status=429 终态事件：同样收到 CLOSE 1011，错误帧未透传；两种变体预备帧均未下发；
- Codex 客户端重连：通过（HTTP fallback 完成）。Codex CLI 0.171 TUI + supports_websockets=true 在 1011 后新开 WS 连接 #2–#4 并重发 response.create；同一轮也发起 HTTP POST，补全 HTTP SSE 上游后 TUI 显示 http-ok。客户端在 1011 后完成恢复；但成功回答由 HTTP fallback 提供，不是重连后的 WS 通道。
- WS 通道独立完成：通过。WS-only 客户端在收到 1011 后自行重连；第二次连接收到 response.completed 与 ws-ok，全程未使用 HTTP。
- 清理：api-key 账号凭据已按备份恢复，临时上游已停止，路由观测测试文件已删除。
