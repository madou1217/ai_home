package accountrouting

import (
	"sync"
	"sync/atomic"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// FairRoundRobinScheduler 为每个 Provider、模型元组分配独立的轮转起点。
//
// 调度器只保存单调票号，不持有账号、凭据或请求状态；进程重启后从零开始即可，
// 公平游标不属于需要持久化的业务事实。
type FairRoundRobinScheduler struct {
	cursors sync.Map
}

// roundRobinKey 隔离不同 Provider 和真实模型的公平游标。
type roundRobinKey struct {
	providerID string
	modelID    runtimecore.ModelID
}

// roundRobinCursor 使用原子票号支持同一模型的并发请求。
type roundRobinCursor struct {
	ticket atomic.Uint64
}

// NextStart 返回当前请求在不可变候选快照中的环形扫描起点。
func (scheduler *FairRoundRobinScheduler) NextStart(
	providerID string,
	modelID runtimecore.ModelID,
	candidateCount int,
) int {
	if scheduler == nil ||
		providerID == "" ||
		!modelID.IsValid() ||
		candidateCount < 1 {
		return 0
	}
	key := roundRobinKey{
		providerID: providerID,
		modelID:    modelID,
	}
	value, found := scheduler.cursors.Load(key)
	if !found {
		value, _ = scheduler.cursors.LoadOrStore(key, &roundRobinCursor{})
	}
	cursor := value.(*roundRobinCursor)
	ticket := cursor.ticket.Add(1) - 1
	return int(ticket % uint64(candidateCount))
}
