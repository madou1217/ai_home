package messages

import "net/http"

// 订阅 OAuth 走的是 Claude Code 的调用合同，不是通用 API Key 合同：Anthropic 依据
// 客户端身份判定订阅额度是否可用。Canonical 转码路径从零构造请求，若不声明这组身份，
// 同一账号、同一时刻、同一模型下原生 relay 成功而 Canonical 被限流。
//
// 下列三个值来自本机 Claude Code 2.1.225 源码与回环抓包（假 Key 打
// 127.0.0.1，未连接 Anthropic）对 POST /v1/messages 的实际合同。不含 SDK 遥测字段
// （x-stainless-*），那些只描述运行环境，不参与身份判定。
const (
	// clientUserAgent 是官方 CLI 自报的客户端身份。
	clientUserAgent = "claude-cli/2.1.225 (external, sdk-cli)"
	// clientAppHeader 声明调用方是 CLI 形态的 Claude Code。
	clientAppHeader = "x-app"
	// clientAppValue 是官方 CLI 在该 Header 上发送的唯一取值。
	clientAppValue = "cli"
	// clientDirectAccessHeader 是官方 CLI 固定声明的直连标记。
	clientDirectAccessHeader = "anthropic-dangerous-direct-browser-access"
	// clientDirectAccessValue 是该标记的官方取值。
	clientDirectAccessValue = "true"
)

// clientSystemIdentity 是官方 CLI 每次请求的首个 system 块。
//
// 取自官方源码 cli/src/constants/prompts.ts:452（本机 Claude Code 快照与
// clawdcodex 参考仓一致）。官方在其后追加 CWD/Date 两行会话上下文，那属于
// 本地环境事实，跨协议调用没有等价语义，因此只保留身份行本身，不自造字段。
const clientSystemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."

// applyClaudeCodeIdentity 为订阅 OAuth 请求补齐官方客户端身份 Header。
//
// 只作用于 OAuth 凭据：API Key 和第三方 auth-token 代理走的是通用 API 合同，
// 冒充官方 CLI 既无必要，也可能被代理按未知客户端拒绝。
func applyClaudeCodeIdentity(header http.Header, oauth bool) {
	if header == nil || !oauth {
		return
	}
	header.Set("User-Agent", clientUserAgent)
	header.Set(clientAppHeader, clientAppValue)
	header.Set(clientDirectAccessHeader, clientDirectAccessValue)
}

// prependClaudeCodeSystem 把官方身份块放在客户端 system 之前。
//
// 订阅额度按 Claude Code 客户端判定，而 Native Relay 之所以可用，正是因为它
// 原样转发了官方客户端自带的这一块；Canonical 重建请求时若丢掉它，同一账号
// 同一时刻会被判为非订阅调用。客户端自己的 system 一律保留在其后，不被覆盖。
func prependClaudeCodeSystem(
	system []contentDTO,
	oauth bool,
) []contentDTO {
	if !oauth {
		return system
	}
	identity := contentDTO{Type: "text", Text: clientSystemIdentity}
	return append([]contentDTO{identity}, system...)
}
