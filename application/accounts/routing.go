package accounts

import (
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultRoutingLimit 是未指定分页大小时的默认候选诊断页大小。
	DefaultRoutingLimit = 32
	// MaxRoutingLimit 防止一次候选诊断查询意外复制过多账号。
	MaxRoutingLimit = 256
)

var (
	// ErrInvalidRoutingQuery 表示账号征召查询不满足 Provider、游标或分页约束。
	ErrInvalidRoutingQuery = errors.New("账号征召查询无效")
	// ErrInvalidRoutingAccount 表示持久化层返回了无效的紧凑账号投影。
	ErrInvalidRoutingAccount = errors.New("账号征召投影无效")
)

// RoutingQuery 是按 Provider 使用 AccountRef 稳定游标的候选诊断查询。
//
// Server 征召热路径使用 RoutingCandidates 原子快照，不使用该分页值。
type RoutingQuery struct {
	providerID string
	modelID    runtimecore.ModelID
	afterRef   accountcore.AccountRef
	limit      int
}

// NewRoutingQuery 校验 Provider、游标和分页大小并创建账号征召查询。
func NewRoutingQuery(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
	afterRef accountcore.AccountRef,
	limit int,
) (RoutingQuery, error) {
	if catalog == nil {
		return RoutingQuery{}, ErrInvalidRoutingQuery
	}
	canonicalProviderID, found := catalog.CanonicalID(providerID)
	if !found {
		return RoutingQuery{}, ErrInvalidRoutingQuery
	}
	runtimeModelID, err := runtimecore.NewModelID(modelID)
	if err != nil {
		return RoutingQuery{}, ErrInvalidRoutingQuery
	}
	if afterRef != "" && !afterRef.IsValid() {
		return RoutingQuery{}, ErrInvalidRoutingQuery
	}
	if limit == 0 {
		limit = DefaultRoutingLimit
	}
	if limit < 1 || limit > MaxRoutingLimit {
		return RoutingQuery{}, ErrInvalidRoutingQuery
	}
	return RoutingQuery{
		providerID: canonicalProviderID,
		modelID:    runtimeModelID,
		afterRef:   afterRef,
		limit:      limit,
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (query RoutingQuery) ProviderID() string {
	return query.providerID
}

// ModelID 返回别名解析后的真实上游模型 ID。
func (query RoutingQuery) ModelID() runtimecore.ModelID {
	return query.modelID
}

// AfterRef 返回不包含在下一页结果中的 AccountRef 游标。
func (query RoutingQuery) AfterRef() accountcore.AccountRef {
	return query.afterRef
}

// Limit 返回本次查询允许返回的最大账号数。
func (query RoutingQuery) Limit() int {
	return query.limit
}

// RoutingAccountInput 是从持久化行构造紧凑账号投影所需的字段。
type RoutingAccountInput struct {
	// Ref 是稳定账号业务身份。
	Ref accountcore.AccountRef
	// ProviderID 是账号所属的规范 Provider ID。
	ProviderID string
	// CLIAccountID 是 Provider 内用户可见数字别名。
	CLIAccountID accountcore.CLIAccountID
}

// RoutingAccount 是账号征召热路径常驻内存的最小只读投影。
//
// enabled 已由查询条件保证为 true；凭据、资料、时间、usage、模型和运行态均不进入该值。
type RoutingAccount struct {
	ref          accountcore.AccountRef
	providerID   string
	cliAccountID accountcore.CLIAccountID
}

// RoutingCandidates 是单个 Provider、模型元组的不可变候选快照。
//
// 构造时只复制一次底层切片；读取方只能按下标取得值，不能修改快照内容。
// 账号管理写路径发布新快照后，已经开始的请求仍安全地使用旧快照完成本轮征召。
type RoutingCandidates struct {
	accounts []RoutingAccount
}

// NewRoutingAccount 校验持久化字段并创建紧凑账号征召投影。
func NewRoutingAccount(catalog *providers.Catalog, input RoutingAccountInput) (RoutingAccount, error) {
	if catalog == nil ||
		!input.Ref.IsValid() ||
		!input.CLIAccountID.IsValid() {
		return RoutingAccount{}, ErrInvalidRoutingAccount
	}
	canonicalProviderID, found := catalog.CanonicalID(input.ProviderID)
	if !found || canonicalProviderID != input.ProviderID {
		return RoutingAccount{}, ErrInvalidRoutingAccount
	}
	return RoutingAccount{
		ref:          input.Ref,
		providerID:   input.ProviderID,
		cliAccountID: input.CLIAccountID,
	}, nil
}

// Ref 返回稳定账号业务身份。
func (account RoutingAccount) Ref() accountcore.AccountRef {
	return account.ref
}

// ProviderID 返回规范 Provider ID。
func (account RoutingAccount) ProviderID() string {
	return account.providerID
}

// CLIAccountID 返回 Provider 内用户可见数字别名。
func (account RoutingAccount) CLIAccountID() accountcore.CLIAccountID {
	return account.cliAccountID
}

// NewRoutingCandidates 复制投影并按稳定身份去重，创建不可变候选快照。
//
// 生产倒排已经按 AccountRef 排序，因此使用相邻去重且不分配辅助 Map；
// 测试或其他 Adapter 提供未排序输入时保留原顺序并使用一次冷路径去重。
func NewRoutingCandidates(accounts []RoutingAccount) *RoutingCandidates {
	snapshot := append([]RoutingAccount(nil), accounts...)
	sorted := routingAccountsSorted(snapshot)
	write := 0
	if sorted {
		for _, account := range snapshot {
			if write > 0 && snapshot[write-1].Ref() == account.Ref() {
				continue
			}
			snapshot[write] = account
			write++
		}
	} else {
		seen := make(map[accountcore.AccountRef]struct{}, len(snapshot))
		for _, account := range snapshot {
			if _, found := seen[account.Ref()]; found {
				continue
			}
			seen[account.Ref()] = struct{}{}
			snapshot[write] = account
			write++
		}
	}
	for index := write; index < len(snapshot); index++ {
		snapshot[index] = RoutingAccount{}
	}
	return &RoutingCandidates{
		accounts: snapshot[:write],
	}
}

// routingAccountsSorted 线性确认生产倒排是否保持 AccountRef 顺序。
func routingAccountsSorted(accounts []RoutingAccount) bool {
	for index := 1; index < len(accounts); index++ {
		if accounts[index-1].Ref().String() > accounts[index].Ref().String() {
			return false
		}
	}
	return true
}

// Len 返回当前快照中的候选账号数量。
func (candidates *RoutingCandidates) Len() int {
	if candidates == nil {
		return 0
	}
	return len(candidates.accounts)
}

// At 返回指定位置的候选值；越界时返回 false。
func (candidates *RoutingCandidates) At(index int) (RoutingAccount, bool) {
	if candidates == nil || index < 0 || index >= len(candidates.accounts) {
		return RoutingAccount{}, false
	}
	return candidates.accounts[index], true
}
