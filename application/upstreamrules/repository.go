package upstreamrules

import (
	"context"
	"errors"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// MaxGroupIDs 是单个账号允许挂载的映射组数量上限（与 Node 的
	// readUpstreamErrorGroupIds 一致）。
	MaxGroupIDs = 20
)

// Source 标识一条记录的写入口。
//
// 历史兼容投影写入过 source=projection 的行；投影写入已移除，新数据只有账号级来源。
type Source string

const (
	// SourceAccount 表示账号级配置。
	SourceAccount Source = "account"
)

var (
	// ErrServiceUnavailable 表示服务缺少必要的存储依赖。
	ErrServiceUnavailable = errors.New("上游错误规则服务不可用")
	// ErrAccountNotFound 表示账号在 Go 的账号表里不存在。
	ErrAccountNotFound = errors.New("上游错误规则所属账号不存在")
	// ErrInvalidAccountRef 表示账号引用为空。
	ErrInvalidAccountRef = errors.New("账号引用无效")
	// ErrInvalidGroupIDs 表示组挂载列表不满足约束。
	ErrInvalidGroupIDs = errors.New("上游错误规则组挂载无效")
)

// Record 是一个账号的规则配置。
//
// Provider 由账号表补全，调用方不能伪造：组作用域判定必须与账号真实 Provider 一致。
type Record struct {
	AccountRef string
	Provider   string
	GroupIDs   []string
	Rules      []rulescore.Rule
}

// Repository 是账号规则的持久化端口。
type Repository interface {
	// AccountProvider 返回账号的真实 Provider；账号不存在时返回 false。
	AccountProvider(ctx context.Context, accountRef string) (string, bool, error)
	// Load 读取单账号记录；没有任何规则或挂载时返回 false。
	//
	// 账号级记录即使规则为空，只要存在组挂载也算存在（组规则仍然生效）。
	Load(ctx context.Context, accountRef string) (Record, bool, error)
	// ReplaceAccount 整体替换账号级配置。
	ReplaceAccount(ctx context.Context, record Record) error
	// DeleteAccountRules 删除账号的规则与组挂载；返回是否真的有数据被删。
	DeleteAccountRules(ctx context.Context, accountRef string) (bool, error)
	// ListAccountRefs 返回所有持有规则或组挂载的账号引用（按引用排序）。
	ListAccountRefs(ctx context.Context) ([]string, error)
}
