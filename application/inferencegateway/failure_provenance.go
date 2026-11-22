package inferencegateway

// 失败来源证据的进程级汇点：ObservedAttemptRecorder 是所有推理入口共享的
// 终态写入守卫，因此只需要一个写入口就能覆盖 HTTP / WebSocket / relay / claude。
//
// 汇点由组合根注入（internal/runtime/failureprovenance），应用层不依赖具体
// 环形缓冲实现；未注入时记录被静默跳过，不影响任何请求路径。

import (
	"sync"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// FailureProvenanceSink 接收一次失败终态的来源证据。
//
// recorded 表示运行态是否接受了这次写入；receipt 携带本次写入的冷却解除时间。
type FailureProvenanceSink interface {
	RecordFailureProvenance(
		route runtimecore.ModelRoute,
		failure AttemptFailure,
		recorded bool,
		receipt runtimecore.CooldownReceipt,
	)
}

var (
	failureProvenanceMu   sync.RWMutex
	failureProvenanceSink FailureProvenanceSink
)

// ConfigureFailureProvenanceSink 替换来源证据汇点；nil 表示关闭记录。
func ConfigureFailureProvenanceSink(sink FailureProvenanceSink) {
	failureProvenanceMu.Lock()
	failureProvenanceSink = sink
	failureProvenanceMu.Unlock()
}

func emitFailureProvenance(
	route runtimecore.ModelRoute,
	failure AttemptFailure,
	recorded bool,
	receipt runtimecore.CooldownReceipt,
) {
	failureProvenanceMu.RLock()
	sink := failureProvenanceSink
	failureProvenanceMu.RUnlock()
	if sink == nil {
		return
	}
	sink.RecordFailureProvenance(route, failure, recorded, receipt)
}