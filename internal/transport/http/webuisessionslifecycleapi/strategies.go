package webuisessionslifecycleapi

import (
	"context"
	"net/http"
	"strings"
)

// lifecycleStrategy 是一个 Provider 的会话归档策略。
//
// 归档/恢复的实际事实源与能力声明必须来自同一个对象：此前三个 switch 各自维护
// 「哪些 Provider 走文件归档、哪些走 app-server」，新增 Provider 容易只改一半。
type lifecycleStrategy interface {
	// Capability 声明该 Provider 的归档能力（动态探测失败时降级为 available=false）。
	Capability(ctx context.Context) providerCapability
	// Archive 归档一个会话；重复归档必须幂等。
	Archive(ctx context.Context, sessionID string) (archiveResult, error)
	// Unarchive 恢复一个会话；origin=legacy 表示旧版文件归档来源。
	Unarchive(ctx context.Context, sessionID string, origin string) (archiveResult, error)
}

// lifecycleStrategyFor 返回 Provider 的归档策略；未登记的 Provider 明确不支持。
func (handler *Handler) lifecycleStrategyFor(provider string) lifecycleStrategy {
	if strategy, found := handler.strategies[normalizeProvider(provider)]; found {
		return strategy
	}
	return unsupportedLifecycle{provider: normalizeProvider(provider)}
}

// codexLifecycle 通过 app-server 的 thread/archive 与 thread/unarchive 操作会话。
type codexLifecycle struct {
	handler *Handler
}

func (strategy codexLifecycle) Capability(ctx context.Context) providerCapability {
	return strategy.handler.codexCapability(ctx)
}

func (strategy codexLifecycle) Archive(ctx context.Context, sessionID string) (archiveResult, error) {
	if err := strategy.handler.archiveCodexThread(ctx, sessionID); err != nil {
		return archiveResult{}, err
	}
	return archiveResult{
		Provider:        providerCodex,
		SessionID:       sessionID,
		NativeSessionID: sessionID,
		Origin:          originNative,
	}, nil
}

func (strategy codexLifecycle) Unarchive(ctx context.Context, sessionID string, origin string) (archiveResult, error) {
	// 旧版文件归档来源只服务 claude/gemini；codex 的 legacy 请求保持「不支持」，
	// 与改造前的 unarchiveLegacy 行为一致。
	if strings.EqualFold(strings.TrimSpace(origin), originLegacy) {
		return archiveResult{}, unsupportedUnarchiveError(providerCodex)
	}
	if err := strategy.handler.unarchiveCodexThread(ctx, sessionID); err != nil {
		return archiveResult{}, err
	}
	return archiveResult{
		Provider:        providerCodex,
		SessionID:       sessionID,
		NativeSessionID: sessionID,
		Origin:          originNative,
	}, nil
}

// legacyFileLifecycle 直接改写 Provider 自己的会话目录（.archived 子目录）。
type legacyFileLifecycle struct {
	provider string
	archive  func(sessionID string) error
	restore  func(sessionID string) error
}

func (strategy legacyFileLifecycle) Capability(context.Context) providerCapability {
	return fileArchiveCapability(strategy.provider)
}

func (strategy legacyFileLifecycle) Archive(_ context.Context, sessionID string) (archiveResult, error) {
	if err := strategy.archive(sessionID); err != nil {
		return archiveResult{}, err
	}
	return archiveResult{
		Provider:        strategy.provider,
		SessionID:       sessionID,
		NativeSessionID: sessionID,
		Origin:          originLegacy,
	}, nil
}

func (strategy legacyFileLifecycle) Unarchive(_ context.Context, sessionID string, _ string) (archiveResult, error) {
	if err := strategy.restore(sessionID); err != nil {
		return archiveResult{}, err
	}
	return archiveResult{
		Provider:  strategy.provider,
		SessionID: sessionID,
		Origin:    originLegacy,
	}, nil
}

// unsupportedLifecycle 表示没有事实源证明该 Provider 支持归档。
type unsupportedLifecycle struct {
	provider string
}

func (strategy unsupportedLifecycle) Capability(context.Context) providerCapability {
	return unsupportedCapability(strategy.provider)
}

func (strategy unsupportedLifecycle) Archive(context.Context, string) (archiveResult, error) {
	return archiveResult{}, &lifecycleError{
		status:  http.StatusUnprocessableEntity,
		code:    codeSessionArchiveUnsupported,
		message: strategy.provider + " 不支持原生归档",
	}
}

func (strategy unsupportedLifecycle) Unarchive(context.Context, string, string) (archiveResult, error) {
	return archiveResult{}, unsupportedUnarchiveError(strategy.provider)
}

// unsupportedUnarchiveError 统一「不支持恢复」的错误形状。
func unsupportedUnarchiveError(provider string) error {
	return &lifecycleError{
		status:  http.StatusUnprocessableEntity,
		code:    codeSessionUnarchiveUnsupported,
		message: provider + " 不支持原生恢复",
	}
}
