package responseswebsocket

import (
	"net/http"
	"regexp"
	"strings"
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

// maxForwardedHeaderBytes 限制透传头长度（turn-metadata 实测约 600 字节）。
const maxForwardedHeaderBytes = 4096

// codexOriginatorPattern 匹配官方 Codex 客户端的 originator（codex_cli_rs、codex_exec、…）。
var codexOriginatorPattern = regexp.MustCompile(`^codex_[a-z0-9_]{1,48}$`)

// codexClientMetadataHeaders 是 Codex 客户端自带、描述自身会话的低敏元数据头。
var codexClientMetadataHeaders = []string{
	"x-codex-turn-metadata",
	"x-codex-beta-features",
	"x-codex-window-id",
	"x-openai-internal-codex-responses-lite",
}

// codexClientIdentity 返回客户端声明的 Codex 身份头；不是可信 Codex 客户端时返回 false。
func codexClientIdentity(source http.Header) (http.Header, bool) {
	originator, ok := singleSafeHeader(source, "Originator")
	if !ok || !codexOriginatorPattern.MatchString(originator) {
		return nil, false
	}
	userAgent, ok := singleSafeHeader(source, "User-Agent")
	if !ok || !strings.HasPrefix(userAgent, originator+"/") {
		return nil, false
	}
	identity := make(http.Header)
	identity.Set("Originator", originator)
	identity.Set("User-Agent", userAgent)
	if version, found := singleSafeHeader(source, "Version"); found {
		identity.Set("Version", version)
	}
	for _, name := range codexClientMetadataHeaders {
		if value, found := singleSafeHeader(source, name); found {
			identity.Set(name, value)
		}
	}
	return identity, true
}

// singleSafeHeader 只接受恰好一个、无控制字符且有长度上限的头值。
func singleSafeHeader(source http.Header, name string) (string, bool) {
	values := source.Values(name)
	if len(values) != 1 || values[0] == "" || len(values[0]) > maxForwardedHeaderBytes {
		return "", false
	}
	for _, char := range values[0] {
		if char < 0x20 || char == 0x7f {
			return "", false
		}
	}
	return values[0], true
}
