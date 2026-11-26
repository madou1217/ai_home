# xAI 官方 SDK 的 gRPC 入口

xAI 官方 Python SDK（`xai-sdk`）使用 gRPC，不提供 HTTP base URL。aih-server 因此
在 HTTP 端口之外启动一个 **gRPC 兼容监听**：

- 默认端口：HTTP 端口 + 1（9527 → 9528）
- 显式配置：`aih-server --grpc-port 9528` 或 `AIH_SERVER_GRPC_PORT=9528`
- 监听地址与 HTTP 相同（当前只允许 loopback）

## 客户端配置

把 gateway client key 作为 xAI SDK 的 `api_key`，把 gRPC 端口作为 `api_host`：

```python
import xai_sdk
from xai_sdk import chat

client = xai_sdk.Client(
    api_key="<gateway client key>",
    api_host="127.0.0.1:9528",
    use_insecure_channel=True,
)

conversation = client.chat.create(
    model="gemini-2.5-flash",  # 任意 gateway 目录中的模型
    messages=[chat.user("Hello")],
)
print(conversation.sample().content)

for response, chunk in conversation.stream():
    print(chunk.content, end="")
```

## 实现边界

gRPC 层只做协议翻译，账号、模型路由、重试和错误策略仍由 HTTP 网关执行：

- `xai_api.Chat/GetCompletion` → `POST /v1/chat/completions`
- `xai_api.Chat/GetCompletionChunk` → `POST /v1/chat/completions` + SSE
- `xai_api.Models/ListLanguageModels` / `GetLanguageModel` → `GET /v1/models`
- embedding / image-generation 模型目录返回空集（当前 Gateway 不提供这两类目录）
- xAI 的 files、batch、video、tokenize、collections 等独立服务不在当前兼容范围

鉴权沿用 HTTP 客户端 Key：gRPC metadata 的 `authorization: Bearer <key>` 会原样
转发到 HTTP 入口；没有 metadata 时使用服务端自己的 client key 兜底。
