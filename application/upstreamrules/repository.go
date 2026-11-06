package upstreamrules

import (
	"context"
	"errors"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// MaxAccounts 限制一次兼容投影推送的账号数，避免异常客户端拖垮进程。
	MaxAccounts = 4096
	// MaxGroupIDs 是单个账号允许挂载的映射组数量上限（与 Node 的
	// readUpstreamErrorGroupIds 一致）。
	MaxGroupIDs = 20
)

// Source 标识一条记录由哪个写入口产生。
//
// 两个来源的语义不同，不能合并：
//   - SourceAccount 是账号级配置（挂载组 + 自身规则），读取时必须拼装；
//   - SourceProjection 是旧接口推来的「已拼装有效规则」，读取时原样使用。
type Source string

const (
	// SourceAccount 表示账号级配置。
	SourceAccount Source = "account"
	// SourceProjection 表示兼容投影（旧 Node 推送的完整有效规则）。
	SourceProjection Source = "projection"
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
	// ErrInvalidProjection 表示兼容投影结构本身非法。
	ErrInvalidProjection = errors.New("上游错误规则投影无效")
)

// Record 是一个账号在某一来源下的规则集合。
//
// Provider 由账号表补全，调用方不能伪造：组作用域判定必须与账号真实 Provider 一致。
type Record struct {
	AccountRef string
	Provider   string
	Source     Source
	GroupIDs   []string
	Rules      []rulescore.Rule
}

// Repository 是账号规则与兼容投影的持久化端口。
//
// 端口按「单账号替换 + 投影整表替换」设计：账号级配置天然按账号独立，逐账号写入
// 才能让两个账号的保存互不覆盖；兼容投影是旧接口的整体快照，必须整表替换才能表达
// 「这次没推的账号要清掉」。
type Repository interface {
	// AccountProvider 返回账号的真实 Provider；账号不存在时返回 false。
	AccountProvider(ctx context.Context, accountRef string) (string, bool, error)
	// Load 读取某个来源下的单账号记录；没有任何规则或挂载时返回 false。
	//
	// 账号级记录即使规则为空，只要存在组挂载也算存在（组规则仍然生效）。
	Load(ctx context.Context, accountRef string, source Source) (Record, bool, error)
	// List 按账号引用排序返回某个来源的全部记录。
	List(ctx context.Context, source Source) ([]Record, error)
	// ReplaceAccount 整体替换账号级配置，并清掉该账号的兼容投影。
	ReplaceAccount(ctx context.Context, record Record) error
	// ReplaceProjection 整体替换兼容投影；账号级配置原样保留。
	ReplaceProjection(ctx context.Context, records []Record) error
	// DeleteAccountRules 删除账号的两个来源与组挂载；返回是否真的有数据被删。
	DeleteAccountRules(ctx context.Context, accountRef string) (bool, error)
	// ListAccountRefs 返回所有持有规则或组挂载的账号引用（按引用排序）。
	ListAccountRefs(ctx context.Context) ([]string, error)
}
