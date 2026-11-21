# Provider 模型命名空间前缀恢复（2026-11-21）

## 结论

Go 前端已恢复 `provider/model` 前缀解析：只认 Provider 合同显式声明的前缀，别名优先、完整 id 优先，解析后把 Provider 钉死。真实请求验证中，prefixed 请求不再漂到别家 Provider；未声明前缀与完整 id 的行为保持不变。

## 缺口来源

- Node 时代 `lib/server/v1-router.js:34` 在别名解析之后调用 `applyProviderModelPrefix`，把 `zcode/glm-5.3` 还原成裸 `glm-5.3`，并经 `x-provider` 把 Provider 钉死（`lib/server/provider-model-prefix.js` 是唯一消费方）。
- 该网关随 `edbc4405` 删除后，消费方零引用；Go 侧只有插件描述符的契约校验（`internal/runtime/pluginhost/descriptors.go`），没有运行时解析。
- 修复前实测：`POST /v1/chat/completions`，`model=zcode/glm-5.3` → 503（3/3，约 2ms）。

## 实现

- `core/providers`：`Definition` 新增 `modelPrefix` 合同（supported / reason / aliases），`NewCatalog` 校验；zcode 声明 `zcode` 与 `zai`。
- `application/modelprefix`：编译前缀→Provider 只读索引；同一前缀被多个 Provider 声明时视为歧义并移除。
- `relaycore`：别名未命中时解析前缀 → 请求体模型改写为裸 id → 通过上下文钉选 Provider；账号来源链只询问被钉选的 Provider。
- 交还 Canonical 时保留 `X-Provider` 钉选，避免裸 id 重新进入全局池后漂到别家（与 Node 的 `withExplicitProvider` 同义）。
- 完整 id 优先：请求字面量本身在可路由模型目录中存在时，不做任何改写。

## 真实验证

本机 Go server 重建并重启后，`POST /v1/chat/completions`：

| 请求 | 结果 |
| --- | --- |
| `zcode/glm-5.3` | 503（钉死 zcode 后的如实失败） |
| `zai/glm-5.3` | 503（同上） |
| `bogusprefix/glm-5.3` | 503（未声明前缀，行为不变） |
| `cline-pass/glm-5.3` | 422（完整 id 优先，未改写） |
| `glm-5.3` | 403，`X-Aih-Server-Provider: codebuddy`（裸模型行为不变） |
| `X-Provider: claude` + `zcode/glm-5.3` | 503（显式冲突时不改写） |
| `X-Provider: zcode` + `zcode/glm-5.3` | 503（钉死，不回落别家） |

正证据链：同一请求在“仅改写、未把钉选传给 Canonical”的中间构建上返回 200，`X-Aih-Server-Provider: claude`、响应 `model=glm-5.3`；加入钉选传递后变为 503。这说明前缀改写确实发生，且钉选阻止了跨 Provider 漂移。

## 已知边界

- zcode 账号当前仍无法由 Go 透传通道完成上游推理（凭据/套餐状态），因此 prefixed 请求的最终结果是“钉死到 zcode 后的如实失败”，不是 200；这是独立缺口。
- `/v1/messages` 仍未挂载 zcode 透传模块（`zcoderelay.Path` 是上游地址后缀，不是本地挂载）；Anthropic 原生客户端走该路径的行为不受本次修复影响。
- Provider 钉选下，多 Provider 的账号来源（家族/插件链）会被跳过；当前只有 zcode 声明前缀，因此不影响现有 Provider。若未来家族 Provider 声明前缀，需要给多 Provider 来源补按 Provider 过滤的能力。

## 提交

- `466a2def feat(routing): resolve provider model prefixes in the Go relay`
- `c190861d fix(relay): keep the provider pin when falling back to canonical`