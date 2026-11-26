# 9527 新网关重启与官方 SDK 验证（2026-11-26）

## 重启

- 方式：`launchctl kickstart -k gui/501/com.meadeo.ai_home`
- 进程：`aih-server PID 42273`
- HTTP：`127.0.0.1:9527`，`/readyz` ready
- xAI gRPC：`127.0.0.1:9528`
- 运行二进制包含 `4d55bb11 feat(grpc): bridge xAI SDK chat and model catalog`

## SDK 验证矩阵

| SDK / 调用 | 结果 |
|---|---|
| Anthropic `models.list(limit=2)` | 通过，第一页 2 条 |
| Anthropic `messages.create` | 通过 |
| OpenAI Responses `gpt-5.6-sol` + `max_output_tokens` / `temperature` / `top_p` / `metadata` | 通过，返回 `ok` |
| OpenAI Chat `gemini-2.5-flash` | 通过，返回 `ok` |
| Google `models.list()` | 通过，146 个模型 |
| Google `count_tokens` | 通过，`totalTokens=16` |
| Google `generate_content` | 通过，返回 `ok` |
| xAI gRPC `models.list_language_models()` | 通过，146 个模型 |
| xAI gRPC `chat.sample()` | 通过，返回 `ok` |
| xAI gRPC `chat.stream()` | 通过，流式返回 `ok` |
| 智谱 SDK 默认 `/api/paas/v4` | 路径通过；返回 `3006 zcode_model_not_allowed`，属账号套餐限制 |
| Anthropic 未知模型 | 404 `not_found_error` |
| OpenAI 未知模型 | 404 `model_not_found` |
| Google 未知模型 | 404 `NOT_FOUND` |

## 结论

- 新网关 HTTP 入口和 xAI gRPC 入口均在线。
- 标准 SDK 的模型目录、分页、未知模型 404、Codex 可选参数宽容处理均生效。
- 智谱 GLM 的 400 是账号套餐限制，不是协议路径缺失。
