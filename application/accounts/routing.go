package accounts

import (
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultRoutingLimit 是未指定分页大小时的默认账号征召数量。
	DefaultRoutingLimit = 32
	// MaxRoutingLimit 防止一次征召查询意外加载过多账号。
	MaxRoutingLimit = 256
)

var (
	// ErrInvalidRoutingQuery 表示账号征召查询不满足 Provider、游标或分页约束。
	ErrInvalidRoutingQuery = errors.New("账号征召查询无效")
	// ErrInvalidRoutingAccount 表示持久化层返回了无效的紧凑账号投影。
	ErrInvalidRoutingAccount = errors.New("账号征召投影无效")
)

// RoutingQuery 是按 Provider 使用 AccountRef 稳定游标分页的账号征召查询。
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
