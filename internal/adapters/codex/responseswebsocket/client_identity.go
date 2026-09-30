package responseswebsocket

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

// WS 握手的客户端身份跟随真实 Codex 客户端。
//
// WS 路径原样转发客户端帧，帧形状由客户端版本决定（Codex CLI 0.158 发 Responses Lite
// 帧）。握手若仍自报固定的 codex_cli_rs/0.146.0 并丢掉客户端的会话元数据，上游看到的
// 版本与帧形状不一致。Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）实测握手头：
//   User-Agent: codex_exec/0.158.0-alpha.2.1 (Mac OS …; arm64) …
//   Originator: codex_exec
//   OpenAI-Beta: responses_websockets=2026-02-06
//   x-codex-turn-metadata / x-codex-beta-features / x-codex-window-id
//   x-client-request-id / session-id / thread-id
// 且不发送 Version 头。只有能证明是 Codex 客户端（Originator 为 codex_* 且 User-Agent
// 以它开头）时才透传这些身份头；其它客户端沿用固定的兜底身份。

// codexClientIdentity 返回客户端声明的 Codex 身份头；不是可信 Codex 客户端时返回 false。
func codexClientIdentity(source http.Header) (http.Header, bool) {
	return codexidentity.ClientHeaders(source)
}
