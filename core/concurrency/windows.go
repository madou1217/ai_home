// Package concurrency 的滚动限流窗口契约（纯领域）。
//
// 统计适配器（clientkeystats）实现 WindowSource/AdmissionRecorder；准入控制器只
// 依赖这里的只读快照与记录端口，因此 core 不依赖任何具体统计实现。
package concurrency

import (
	"context"
	"time"
)

// Window 是某个限流主体在滚动窗口内已占用的用量。
//
// Requests/Tokens 是窗口内已计入的请求数与 token 数；Oldest*At 是最早仍计入的
// 那一批样本整体过期、窗口开始释放容量的时刻（零值表示窗口为空）。Retry-After
// 由调用方用它与当前时间求差得出。
type Window struct {
	Requests        int64
	Tokens          int64
	OldestRequestAt time.Time
	OldestTokenAt   time.Time
}

// WindowSource 提供限流窗口的只读快照。
//
// KeyWindow 只统计已准入的真实上游调用；AccountWindow 同口径按账号聚合。
// KeyDailyTokens 返回某 Key 自 UTC 零点起的累计 token（跨重启由持久桶补齐）。
type WindowSource interface {
	KeyWindow(keyID string) Window
	AccountWindow(accountRef string) Window
	KeyDailyTokens(ctx context.Context, keyID string) int64
}

// AdmissionRecorder 记录一次被准入的真实上游调用。
//
// 只有通过准入的调用才会调用它，因此被拒绝的请求不会消耗 RPM/TPM 名额。
type AdmissionRecorder interface {
	RecordAdmitted(keyID, accountRef string)
}
