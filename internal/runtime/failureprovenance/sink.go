package failureprovenance

// 本文件把应用层的失败终态汇点接到环形缓冲上。
//
// internal 包可以依赖 application；反向不行，因此适配器放在这里，由组合根
// 安装一次。汇点只记录低敏标识，不读取响应正文。

import (
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/runtime/serverlog"
)

// Sink 实现 inferencegateway.FailureProvenanceSink。
type Sink struct{}

// Install 把进程级汇点指向默认环形缓冲。
func Install() {
	inferencegateway.ConfigureFailureProvenanceSink(Sink{})
}

// RecordFailureProvenance 写入一条命中记录。
func (Sink) RecordFailureProvenance(
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
