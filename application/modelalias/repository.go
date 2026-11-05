package modelalias

import "context"

// Repository 是别名表的持久化端口。
//
// 为什么放在应用层而不是直接用 sqlite：Store 既服务「Node 推送的内存投影」，
// 也要能「重启后自己恢复」。把持久化抽成端口后，Store 的语义不变，
// 有仓储就落库、没有就只保留内存（测试与只读场景）。
type Repository interface {
	// Load 返回全部别名与当前代次；空表时返回空集合与 0。
	Load(ctx context.Context) ([]Record, int64, error)
	// Save 整体替换别名集合并推进代次，返回新代次。
	Save(ctx context.Context, records []Record) (int64, error)
}
