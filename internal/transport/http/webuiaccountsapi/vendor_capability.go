package webuiaccountsapi

// 本文件是账号行的「对端厂商能力」投影。
//
// 为什么单独成文件：厂商事实属于共享契约（contracts/vendor-endpoints），不是账号页
// 的展示逻辑。行装配只调用一个解析函数，前端也只消费事实字段；新增厂商不需要改这里，
// 更不需要在行装配里写 `switch provider`。

import (
	"strings"

	vendorendpoints "github.com/madou1217/ai_home/contracts/vendor-endpoints"
)

// VendorCapability 是账号绑定的双协议厂商能力（只读事实投影）。
//
// 两个 Base URL 都来自厂商契约，而不是从账号地址猜测：前者是该账号当前使用的协议，
// 后者是同厂商另一门协议的端点。前端据此提示「这个账号还能原生服务另一种客户端」。
type VendorCapability struct {
	VendorID string `json:"vendorId"`
	Label    string `json:"vendorLabel"`
	// AccountProtocol 是账号**当前**配置使用的协议（anthropic / openai）。
	//
	// 前端据此判断「另一门协议」是哪一个，不需要按 Provider 名猜测：
	// 账号归属 Provider 与协议不是一回事（codex 账号可以指向厂商的 Anthropic 端点）。
	AccountProtocol string `json:"accountProtocol"`
	// AnthropicBaseURL 非空表示同一密钥可用 Anthropic 兼容端点。
	AnthropicBaseURL string `json:"anthropicBaseUrl,omitempty"`
	// OpenAIBaseURL 非空表示同一密钥可用 OpenAI 兼容端点。
	OpenAIBaseURL string `json:"openaiBaseUrl,omitempty"`
}

// OtherProtocol 返回与账号当前协议不同的那一门协议；厂商只提供一门时返回空串。
func (capability VendorCapability) OtherProtocol() string {
	switch capability.AccountProtocol {
	case vendorendpoints.ProtocolAnthropic:
		if capability.OpenAIBaseURL != "" {
			return vendorendpoints.ProtocolOpenAI
		}
	case vendorendpoints.ProtocolOpenAI:
		if capability.AnthropicBaseURL != "" {
			return vendorendpoints.ProtocolAnthropic
		}
	}
	return ""
}

// resolveVendorCapability 按账号的凭据地址解析厂商能力。
//
// 未知厂商（含官方端点与任意第三方代理）返回 nil：前端不会凭空显示一个
// 无法验证的能力。
func resolveVendorCapability(baseURL string) *VendorCapability {
	resolution, found := vendorendpoints.Resolve(strings.TrimSpace(baseURL))
	if !found {
		return nil
	}
	capability := &VendorCapability{
		VendorID:         strings.TrimSpace(resolution.Vendor.ID),
		Label:            strings.TrimSpace(resolution.Vendor.Label),
		AccountProtocol:  resolution.Protocol,
		AnthropicBaseURL: resolution.ProtocolBaseURL(vendorendpoints.ProtocolAnthropic),
		OpenAIBaseURL:    resolution.ProtocolBaseURL(vendorendpoints.ProtocolOpenAI),
	}
	if capability.VendorID == "" ||
		(capability.AnthropicBaseURL == "" && capability.OpenAIBaseURL == "") {
		return nil
	}
	return capability
}
