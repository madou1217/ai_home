// Package modelalias 是 Go 数据面读取 Node 模型别名投影的应用层。
//
// Node 控制面是别名的唯一 owner（别名表存在 app-state.db，由 WebUI 维护）；
// 它把启用的别名整体推给 Go，Go 只读这份投影，从不自行持久化或改写别名。
// 本包只保存记录与代次，不解释 Provider 作用域，也不构造路由——把别名编译成
// 路由属于 inferencecatalog，需要模型快照与 Provider Factory 才能完成。
package modelalias

import (
	"errors"
)

const (
	// MaxRecords 限制一次投影可接收的别名数量。
	MaxRecords = 4096
	// ScopeAll 表示别名对所有客户端协议入口生效（与 Node 的 provider="all" 一致）。
	ScopeAll = "all"
	// TargetProviderAuto 表示目标 Provider 由目标模型自身推导（与 Node 的 targetProvider="auto" 一致）。
	TargetProviderAuto = "auto"
)

// ErrInvalidAlias 表示别名记录结构无效（缺少别名或目标）。
var ErrInvalidAlias = errors.New("模型别名记录无效")

// ErrInvalidProjection 表示投影整体无效（超限或重复 id）。
var ErrInvalidProjection = errors.New("模型别名投影无效")

// Record 是 Node 别名表的一条记录，字段与 Node normalizeAliasRecord 对齐。
//
// Enabled 用指针区分「未提供」与「显式 false」：Node 总是显式发送该字段，
// 缺失时按启用处理，避免一次不完整推送把全部别名静默停用。
type Record struct {
	ID             string `json:"id"`
	Alias          string `json:"alias"`
	Target         string `json:"target"`
	Provider       string `json:"provider"`
	TargetProvider string `json:"targetProvider"`
	Priority       int32  `json:"priority"`
	Enabled        *bool  `json:"enabled"`
	Description    string `json:"description"`
}

// IsEnabled 报告别名是否启用；未提供 Enabled 时按启用处理。
func (record Record) IsEnabled() bool {
	return record.Enabled == nil || *record.Enabled
}

// ScopeProvider 返回规范化的作用域 Provider（空值按 all 处理）。
func (record Record) ScopeProvider() string {
	if record.Provider == "" {
		return ScopeAll
	}
	return record.Provider
}

// ResolvedTargetProvider 返回规范化的目标 Provider（空值按 auto 处理）。
func (record Record) ResolvedTargetProvider() string {
	if record.TargetProvider == "" {
		return TargetProviderAuto
	}
	return record.TargetProvider
}

// IsValid 校验跨层传递后的记录不变量。
func (record Record) IsValid() bool {
	return record.Alias != "" && record.Target != ""
}
