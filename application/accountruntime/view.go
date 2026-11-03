package accountruntime

import (
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// AccountView 是单个账号当前运行态的只读投影，供管理面（账号页调度状态）展示。
//
// 只包含阻塞/冷却的类型与时间，不含凭据、请求内容或 Provider 原文。
// 硬阻塞没有到期时间：由 Blocks 中列出的外部真相源更新后解除。
type AccountView struct {
	AccountRef accountcore.AccountRef
	// Blocks 是账号级硬阻塞在等待的恢复事件（整号不可征召）。
	Blocks []runtimecore.RecoveryTrigger
	// Models 是只影响单个真实模型的硬阻塞或 cooldown。
	Models []ModelView
	// LastSuccessAt / LastFailureAt 是本进程观察到的最近一次上游尝试结果。
	LastSuccessAt   time.Time
	LastFailureAt   time.Time
	LastFailureKind string
}

// ModelView 是账号模型元组的只读运行态。
type ModelView struct {
	Model         runtimecore.ModelID
	Blocks        []runtimecore.RecoveryTrigger
	CooldownKind  runtimecore.FailureKind
	CooldownUntil time.Time
}

// Snapshotter 返回当前全部非健康或有近期活动的账号运行态投影。
type Snapshotter interface {
	RuntimeSnapshot() []AccountView
}
