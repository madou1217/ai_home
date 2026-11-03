package inferencegateway

import (
	"context"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// PluginRejection 是 gateway.attempt 中间件拒绝一次尝试的公开信息（上游零命中）。
//
// 传输层按 Status/Code/Message 写出与 Node 相同的插件错误响应（Node 的
// createAttemptMiddleware → writePluginError），而不是把它压成通用的 503。
type PluginRejection struct {
	Status  int
	Code    string
	Message string
}

func (rejection *PluginRejection) Error() string {
	return fmt.Sprintf("插件拒绝本次尝试（%d %s）：%s", rejection.Status, rejection.Code, rejection.Message)
}

// attemptJournal 是请求级的尝试记账：插件看到的 attempt 序号与最后一次失败文本。
//
// Node 的 request-orchestrator 把 currentAttempt 与 lastError 传给中间件；Go 的编排循环
// 按路由计划分层（每个 round 有各自的本地计数），所以这里用请求级记账保持同一口径。
type attemptJournal struct {
	attempts  int
	lastError string
}

type attemptJournalContextKey struct{}

// withAttemptJournal 给请求装上尝试记账；每个请求一次。
func withAttemptJournal(ctx context.Context) context.Context {
	return context.WithValue(ctx, attemptJournalContextKey{}, &attemptJournal{})
}

func attemptJournalFrom(ctx context.Context) *attemptJournal {
	if ctx == nil {
		return nil
	}
	journal, _ := ctx.Value(attemptJournalContextKey{}).(*attemptJournal)
	return journal
}

// nextAttemptIndex 返回本次尝试的序号（0 起）。
func (journal *attemptJournal) nextAttemptIndex() int {
	if journal == nil {
		return 0
	}
	index := journal.attempts
	journal.attempts++
	return index
}

// recordError 记录最近一次尝试的失败文本（插件摘要里的 error 字段）。
func (journal *attemptJournal) recordError(message string) {
	if journal == nil || message == "" {
		return
	}
	journal.lastError = message
}

func (journal *attemptJournal) lastFailure() string {
	if journal == nil {
		return ""
	}
	return journal.lastError
}

// hasAttemptPlugin 报告请求固定的代次是否有 gateway.attempt 贡献项（热路径：没有时零开销直通）。
func hasAttemptPlugin(ctx context.Context) bool {
	pin := pluginruntime.PinFrom(ctx)
	return pin != nil && pin.Projection.Has(pluginruntime.CapabilityGatewayAttempt)
}

// runPluginAttemptStage 在请求固定的插件代次上把一次尝试包进 gateway.attempt 中间件。
//
// ran=false 表示这个请求不经过 gateway.attempt（没有代次或没有该能力的贡献项），调用方直接执行尝试。
// ran=true 时 outcome/err 是最终结果：插件拒绝时返回 *PluginRejection，插件要求停止换号时
// outcome.retry 已被收窄为 false（该失败按尝试耗尽提交）。
func (coordinator *Coordinator) runPluginAttemptStage(
	ctx context.Context,
	invocation Invocation,
	stream *attemptStream,
	accountFailures *requestAccountFailureRecorder,
	run func(ctx context.Context) (attemptOutcome, error),
) (attemptOutcome, error, bool) {
	if !hasAttemptPlugin(ctx) {
		return attemptOutcome{}, nil, false
	}
	journal := attemptJournalFrom(ctx)
	var inner attemptOutcome
	var innerErr error
	stage, ran := pluginruntime.RunPinnedAttemptStage(ctx, pluginruntime.AttemptRequest{
		Provider:   string(invocation.Route().ProviderID()),
		Model:      invocation.Route().EffectiveModel(),
		AccountRef: invocation.Account().Ref().String(),
		AuthType:   pluginAuthType(invocation.Credential()),
		Attempt:    journal.nextAttemptIndex(),
		Run: func(runCtx context.Context) (pluginruntime.AttemptRun, error) {
			inner, innerErr = run(runCtx)
			if innerErr != nil || inner.failure.IsValid() {
				journal.recordError(attemptFailureText(inner, innerErr))
			}
			return pluginruntime.AttemptRun{Action: attemptActionOf(inner, innerErr), Err: innerErr}, innerErr
		},
		Commit:    stream.Committed(),
		Committed: stream.Visible,
		LastError: journal.lastFailure,
	}, pluginruntime.AttemptOptions{})
	if !ran {
		return attemptOutcome{}, nil, false
	}
	if !stage.Started {
		if stage.Rejected != nil {
			return attemptOutcome{}, &PluginRejection{
				Status:  stage.Rejected.Status,
				Code:    stage.Rejected.Code,
				Message: stage.Rejected.Message,
			}, true
		}
		return attemptOutcome{}, ErrInvalidAttemptResult, true
	}
	if stage.Err != nil {
		return inner, stage.Err, true
	}
	if stage.Stop && !stream.Visible() && inner.retry {
		// 插件要求停止换号：只对未提交的失败有效，按尝试耗尽提交这次失败。
		if err := coordinator.stopFailover(ctx, stream, accountFailures); err != nil {
			return inner, err, true
		}
		inner.retry = false
	}
	return inner, innerErr, true
}

// stopFailover 把一次尚未提交的失败按尝试耗尽提交给客户端。
//
// 与 Node 的 pluginStop 语义一致（request-orchestrator 返回 attempts_exhausted）：不换号，
// 客户端拿到这条已记录的安全失败。
func (coordinator *Coordinator) stopFailover(
	ctx context.Context,
	stream *attemptStream,
	accountFailures *requestAccountFailureRecorder,
) error {
	if err := accountFailures.FinalizeFailure(ctx); err != nil {
		return fmt.Errorf("提交请求级上游失败状态失败: %w", err)
	}
	return stream.FlushTerminal()
}

// attemptActionOf 把 Go 的尝试结果映射为插件看到的 outcome.action（与 Node 同名）。
func attemptActionOf(outcome attemptOutcome, err error) string {
	switch {
	case err != nil:
		return "error"
	case outcome.retry:
		return "retry_next"
	default:
		return "return"
	}
}

// attemptFailureText 是给插件看的失败文本（与 Node lastError 同口径：低敏、截断由阶段层做）。
func attemptFailureText(outcome attemptOutcome, err error) string {
	if err != nil {
		return err.Error()
	}
	if outcome.failure.IsValid() {
		return outcome.failure.ResponseFailure().SafeMessage()
	}
	return ""
}

// pluginAuthType 是插件看到的认证形态：静态密钥报 api-key，其余报凭据声明的类型（缺省 oauth）。
//
// 与 internal/host/aihserver 的账号投影同一归一化（api_key / api-key 都算 api-key），
// 保证同一个账号在 Go 的观察事件与尝试中间件里看到同一个值。
func pluginAuthType(credential accountapp.Credential) string {
	if native, ok := credential.(*accountcore.NativeCredential); ok && native != nil {
		switch kind := strings.TrimSpace(native.AuthKind()); kind {
		case "api_key", "api-key":
			return "api-key"
		case "":
			// 落回静态密钥判定
		default:
			return kind
		}
	}
	// API Key / Auth Token / PAT 这类不可刷新凭据在 Node 侧就是 apiKeyMode：插件看到 api-key。
	if accountapp.IsStaticSecretCredential(credential) {
		return "api-key"
	}
	return "oauth"
}
