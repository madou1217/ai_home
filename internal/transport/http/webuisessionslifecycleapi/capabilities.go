package webuisessionslifecycleapi

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
)

const (
	// supportNative / supportUnsupported 是操作支持态，取值集合由前端类型固定。
	supportNative      = "native"
	supportUnsupported = "unsupported"

	// reasonNativeArchiveUnsupported 表示该 Provider 没有原生归档能力。
	reasonNativeArchiveUnsupported = "native_archive_unsupported"
	// reasonNativeUnarchiveUnavailable 与 Node 对 opencode 的声明一致：
	// 能归档但没有原生恢复。
	reasonNativeUnarchiveUnavailable = "native_unarchive_unavailable"
	// reasonProviderRuntimeNotFound 表示运行时不可用（未接线或启动失败）。
	// 这不是「Provider 不支持」，只代表当前进程访问不到。
	reasonProviderRuntimeNotFound = "provider_runtime_not_found"
	// reasonRuntimeProbeFailed 表示运行时起来了但能力探测失败。
	reasonRuntimeProbeFailed = "native_runtime_unavailable"

	providerCodex    = "codex"
	providerClaude   = "claude"
	providerGemini   = "gemini"
	providerOpenCode = "opencode"
)

// capabilities 汇总所有 Provider 的能力声明。
//
// 每个 Provider 都出现在结果里：缺失条目会让前端退回默认的「不支持」提示，
// 与显式声明 unsupported 的语义不同。
func (handler *Handler) capabilities(ctx context.Context) map[string]providerCapability {
	result := make(map[string]providerCapability, len(handler.providerIDs))
	for _, provider := range handler.providerIDs {
		switch provider {
		case providerCodex:
			result[provider] = handler.codexCapability(ctx)
		case providerClaude, providerGemini:
			// 会话文件归档由本包实现：三个动作都作用在 Provider 自己的会话目录上。
			result[provider] = fileArchiveCapability(provider)
		default:
			result[provider] = unsupportedCapability(provider)
		}
	}
	return result
}

// fileArchiveCapability 声明由会话文件归档支撑的能力。
//
// support 取 native 而不是 unsupported：归档直接改写 Provider 自己的会话布局
// （.archived 子目录），能力真实可用；写 unsupported 会让前端隐藏动作，
// 与归档接口的实际行为矛盾。
func fileArchiveCapability(provider string) providerCapability {
	available := operationCapability{Support: supportNative, Available: true}
	return providerCapability{
		Provider:          provider,
		WorkflowAvailable: true,
		Operations: operationSet{
			Archive:      available,
			ListArchived: available,
			Unarchive:    available,
		},
	}
}

// unsupportedCapability 表示没有事实源证明该 Provider 支持归档。
func unsupportedCapability(provider string) providerCapability {
	reason := reasonNativeArchiveUnsupported
	if provider == providerOpenCode {
		reason = reasonNativeUnarchiveUnavailable
	}
	return providerCapability{
		Provider:          provider,
		WorkflowAvailable: false,
		Operations:        emptyOperations(),
		Reason:            reason,
	}
}

// unavailableCapability 表示 Provider 原生支持，但当前进程访问不到运行时。
//
// support 保持 native、available 置 false，并给出原因：前端据此把归档动作置灰，
// 而不是当作「这个 Provider 不支持归档」直接隐藏。
func unavailableCapability(provider, reason string) providerCapability {
	unavailable := operationCapability{Support: supportNative, Available: false, Reason: reason}
	return providerCapability{
		Provider:          provider,
		WorkflowAvailable: false,
		Operations: operationSet{
			Archive:      unavailable,
			ListArchived: unavailable,
			Unarchive:    unavailable,
		},
		Reason: reason,
	}
}

// emptyOperations 是「没有操作可用」的固定形状：三个键必须都在，
// 前端按 operations.archive.support 判定，缺键与 unsupported 等价但更难排查。
func emptyOperations() operationSet {
	unsupported := operationCapability{Support: supportUnsupported}
	return operationSet{
		Archive:      unsupported,
		ListArchived: unsupported,
		Unarchive:    unsupported,
	}
}

// codexCapability 通过 app-server 探测 Codex 的三个归档方法。
func (handler *Handler) codexCapability(ctx context.Context) providerCapability {
	if handler.codex == nil {
		return unavailableCapability(providerCodex, reasonProviderRuntimeNotFound)
	}
	client, err := handler.codex(ctx)
	if err != nil || client == nil {
		return unavailableCapability(providerCodex, reasonProviderRuntimeNotFound)
	}
	defer func() { _ = client.Close() }()

	probeCtx, cancel := context.WithTimeout(ctx, codexTimeout)
	defer cancel()
	probed, err := client.ProbeCapabilities(probeCtx)
	if err != nil {
		return unavailableCapability(providerCodex, reasonRuntimeProbeFailed)
	}
	return fromProbe(providerCodex, probed)
}

// fromProbe 把 adapter 的探测结果投影成契约形状。
//
// 只做字段搬运与兜底归一：adapter 已经按同一套 support / reason 常量给出结论，
// 这里不再重新判断可用性，避免两处规则漂移。
func fromProbe(provider string, probed appserver.Capabilities) providerCapability {
	return providerCapability{
		Provider:          provider,
		WorkflowAvailable: probed.WorkflowAvailable,
		Operations: operationSet{
			Archive:      fromProbeOperation(probed.Operations.Archive),
			ListArchived: fromProbeOperation(probed.Operations.ListArchived),
			Unarchive:    fromProbeOperation(probed.Operations.Unarchive),
		},
		Reason: strings.TrimSpace(probed.Reason),
	}
}

func fromProbeOperation(operation appserver.Operation) operationCapability {
	support := supportUnsupported
	if operation.Support == appserver.SupportNative {
		support = supportNative
	}
	return operationCapability{
		Support:   support,
		Available: support == supportNative && operation.Available,
		Reason:    strings.TrimSpace(operation.Reason),
	}
}
