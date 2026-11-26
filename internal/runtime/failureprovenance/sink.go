package failureprovenance

// 本文件把应用层的失败终态汇点接到环形缓冲上。
//
// internal 包可以依赖 application；反向不行，因此适配器放在这里，由组合根
// 安装一次。汇点只记录低敏标识，不读取响应正文。

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/requestid"
	"github.com/madou1217/ai_home/internal/runtime/serverlog"
)

// Sink 实现 inferencegateway.FailureProvenanceSink。
type Sink struct{}

// Install 把账号级与请求级失败汇点都指向默认实现。
func Install() {
	inferencegateway.ConfigureFailureProvenanceSink(Sink{})
	inferencegateway.ConfigureRequestFailureSink(Sink{})
}

// RecordRequestFailure 写请求级失败事件（没有产生任何上游尝试的失败）。
func (Sink) RecordRequestFailure(ctx context.Context, failure inferencegateway.RequestFailure) {
	serverlog.Emit("request_failed", map[string]any{
		"requestId": requestid.FromContext(ctx),
		"surface":   failure.Surface,
		"model":     failure.Model,
		"error":     truncate(failure.Error, 300),
	})
}

// truncate 按字符截断低敏摘要，避免异常长文本撑坏日志行。
func truncate(value string, limit int) string {
	if limit <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// RecordFailureProvenance 写入一条命中记录。
func (Sink) RecordFailureProvenance(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
	recorded bool,
	receipt runtimecore.CooldownReceipt,
) {
	kind := failure.RuntimeKind()
	provenance := failure.Provenance()
	action := ""
	if policy, err := runtimecore.PolicyFor(kind); err == nil {
		action = string(policy.Action())
	}
	cooldownUntilMS := int64(0)
	if recorded && receipt.IsValid() {
		if retryAt := receipt.RetryAt(); !retryAt.IsZero() {
			cooldownUntilMS = retryAt.UnixMilli()
		}
	}
	event := Event{
		AtMS:            time.Now().UnixMilli(),
		RequestID:       requestid.FromContext(ctx),
		Provider:        provenance.Provider(),
		AccountRef:      route.AccountRef().String(),
		Model:           route.ModelID().String(),
		Source:          string(provenance.Source()),
		SignalID:        provenance.SignalID(),
		HTTPStatus:      provenance.HTTPStatus(),
		ErrorType:       provenance.ErrorType(),
		ErrorCode:       provenance.ErrorCode(),
		Semantic:        string(kind),
		Action:          action,
		Recorded:        recorded,
		CooldownUntilMS: cooldownUntilMS,
	}
	// 环形缓冲只在进程内存里；失败事实同时写按天日志，重启后仍可追查。
	Record(event)
	serverlog.Emit("upstream_failure", event)
}
