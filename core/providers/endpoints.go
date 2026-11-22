package providers

import (
	"sort"
	"strings"
)

// EndpointMode 描述某个模型在某条客户端入口上的承接方式。
type EndpointMode string

const (
	// EndpointModeNative 表示提供该模型的 Provider 在这条入口上有原生通道：
	// 请求按该协议直接与上游对话，不需要跨协议重建语义。
	EndpointModeNative EndpointMode = "native"
	// EndpointModeConvert 表示入口靠 relay 通道承接：网关把请求翻译成上游协议。
	// 语义仍然正确，但字段投影经过转换，行为可能与原生入口有差异。
	EndpointModeConvert EndpointMode = "convert"
)

// EndpointCapability 是一条「模型 × 客户端入口」的能力账本条目。
//
// 这是**内部账本**：它区分原生与转换、并记录是哪几个 Provider 撑起来的。
// 对外开放的 supported_endpoints 是它的简版投影（只留 path，不区分模式）。
type EndpointCapability struct {
	// Path 是客户端入口路径，例如 /v1/messages。
	Path string
	// Mode 是承接方式：native 或 convert。
	Mode EndpointMode
	// Providers 是能在这条入口服务该模型的 Provider ID（已排序去重）。
	Providers []string
}

// EndpointWire 是某种上游线协议的规范名。
//
// 与客户端入口协议分开：客户端说的是「我用哪门协议说话」，线协议是「网关
// 实际用哪门协议跟上游说话」。codex 账号可以走 Claude Messages 线协议访问
// 厂商的 Anthropic 兼容端点，这类双协议关系只能靠线协议区分。
type EndpointWire struct {
	// Protocol 是 gateway 侧的线协议标识，例如 claude.messages。
	Protocol string
	// Path 是该线协议对应的客户端入口路径。
	Path string
}

// DefaultEndpointWires 是当前各客户端入口到线协议的标准映射。
//
// 只收录「Provider 原生承接该入口时用的线协议」。中继（relay）通道一律
// 视为转换模式，不需要在这里登记。
func DefaultEndpointWires() []EndpointWire {
	return []EndpointWire{
		{Protocol: "claude.messages", Path: "/v1/messages"},
		{Protocol: "codex.responses", Path: "/v1/responses"},
		{Protocol: "agy.code_assist", Path: "/v1/chat/completions"},
		{Protocol: "gemini.code_assist", Path: "/v1beta/models/{model}:generateContent"},
	}
}

// EndpointCapabilities 计算该 Provider 能在哪些客户端入口上服务。
//
// 判定分两级，都不按 Provider 名写分支：
//
//  1. **原生**：合同声明该 Provider 拥有这条线协议（NativeWireProtocols）。
//     只有这里登记的组合才算原生——canonical 通道只说明「有完整上游适配器」，
//     不等于「按这门客户端协议原生收发」。codex 有 Responses 适配器，但它
//     在 /v1/messages 上同样是原生，因为合同声明它也拥有 claude.messages
//     （双协议厂商的 Anthropic 兼容端点）。
//  2. **转换**：canonical 或 relay 通道能承接该入口，但不在原生名单里。
//     请求会被翻译成该 Provider 自己拥有的线协议。
//
// 两者都没有 → 该入口不可服务（不出现在结果里）。
func (definition Definition) EndpointCapabilities(wires []EndpointWire) []EndpointCapability {
	if len(wires) == 0 {
		return nil
	}
	capabilities := make([]EndpointCapability, 0, len(wires))
	seen := make(map[string]int, len(wires))
	for _, wire := range wires {
		path := strings.TrimSpace(wire.Path)
		if path == "" {
			continue
		}
		wireProtocol := strings.TrimSpace(wire.Protocol)
		channel := definition.RelayChannelOn(RelayHostGo, wireProtocol)
		if channel == "" {
			// 该线协议走不通时，再看它是不是靠 relay 挂在这条入口上。
			channel = definition.relayChannelForPath(path)
		}
		if channel == "" {
			continue
		}
		mode := EndpointModeConvert
		if definition.OwnsWireProtocol(wireProtocol) {
			mode = EndpointModeNative
		}
		if index, found := seen[path]; found {
			// 同一路径被更具体的线协议覆盖时，原生优先。
			if mode == EndpointModeNative && capabilities[index].Mode != EndpointModeNative {
				capabilities[index].Mode = mode
			}
			continue
		}
		seen[path] = len(capabilities)
		capabilities = append(capabilities, EndpointCapability{
			Path:      path,
			Mode:      mode,
			Providers: []string{definition.ID},
		})
	}
	return capabilities
}

// relayChannelForPath 判断该 Provider 是否以 relay 通道挂载在某条入口上。
//
// 与 RelayChannelOn 的区别：这里按**入口路径**查，因为 relay 通道的 entries
// 直接声明 `gateway.<protocol>`，而调用方可能只拿到路径。
func (definition Definition) relayChannelForPath(path string) string {
	if definition.RelayHosts == nil || path == "" {
		return ""
	}
	relayHost, found := definition.RelayHosts[RelayHostGo]
	if !found || !relayHost.Supported || relayHost.Channel != RelayChannelRelay {
		return ""
	}
	entry := "gateway." + protocolForPath(path)
	if entry == "gateway." {
		return ""
	}
	if !containsString(relayHost.Entries, entry) {
		return ""
	}
	return RelayChannelRelay
}

// protocolForPath 把客户端入口路径映射回 gateway 侧协议标识。
//
// 只覆盖 relay 通道实际会声明的三个入口；Gemini 入口没有 relay 家族，返回空。
func protocolForPath(path string) string {
	switch path {
	case "/v1/messages":
		return "anthropic.messages"
	case "/v1/responses":
		return "openai.responses"
	case "/v1/chat/completions":
		return "openai.chat_completions"
	}
	return ""
}

// MergeEndpointCapabilities 把多个 Provider 的能力合并成「模型级」账本。
//
// 同一入口若有多家 Provider 可用，模式按「只要有原生就算原生」收敛——
// 对用户来说能走原生就是原生，其余 Provider 作为后备。Providers 去重排序。
func MergeEndpointCapabilities(perProvider [][]EndpointCapability) []EndpointCapability {
	type aggregate struct {
		mode      EndpointMode
		providers map[string]bool
	}
	byPath := make(map[string]*aggregate, 8)
	order := make([]string, 0, 8)
	for _, capabilities := range perProvider {
		for _, capability := range capabilities {
			path := strings.TrimSpace(capability.Path)
			if path == "" {
				continue
			}
			merged, found := byPath[path]
			if !found {
				merged = &aggregate{mode: EndpointModeConvert, providers: map[string]bool{}}
				byPath[path] = merged
				order = append(order, path)
			}
			if capability.Mode == EndpointModeNative {
				merged.mode = EndpointModeNative
			}
			for _, provider := range capability.Providers {
				if trimmed := strings.TrimSpace(provider); trimmed != "" {
					merged.providers[trimmed] = true
				}
			}
		}
	}
	sort.Strings(order)
	result := make([]EndpointCapability, 0, len(order))
	for _, path := range order {
		merged := byPath[path]
		providers := make([]string, 0, len(merged.providers))
		for provider := range merged.providers {
			providers = append(providers, provider)
		}
		sort.Strings(providers)
		result = append(result, EndpointCapability{
			Path:      path,
			Mode:      merged.mode,
			Providers: providers,
		})
	}
	return result
}

// EndpointPaths 是内部账本的对外简版：只保留路径，按稳定顺序。
//
// 这就是 supported_endpoints 的值——对外不区分原生与转换，与 LiteLLM
// 的 supported_endpoints 语义一致（它同样只报路径）。
func EndpointPaths(capabilities []EndpointCapability) []string {
	if len(capabilities) == 0 {
		return nil
	}
	paths := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		if path := strings.TrimSpace(capability.Path); path != "" {
			paths = append(paths, path)
		}
	}
	return paths
}
