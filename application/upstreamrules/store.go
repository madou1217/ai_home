// Package upstreamrules 持有 Node 推送到 Go 的账号自定义上游错误规则投影。
//
// Node 控制面是规则与错误映射分组的唯一 owner：它在账号变更后把每个账号的
// 「有效规则」（账号直接规则 + 命中分组的规则）整体推给 Go，Go 只读这份投影并
// 在分类上游失败时使用。本包不做识别与分类，只回答「这个账号有哪些规则」以及
// 「Go 能否忠实执行它们」——后者决定 Node 是否还要把该账号的请求交还自己处理。
package upstreamrules

import (
	"errors"
	"sort"
	"sync"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// MaxAccounts 限制一次投影推送的账号数，避免异常客户端拖垮进程。
	MaxAccounts = 4096
	// DropProviderNotSupported 表示 Go 尚未接入该 Provider 的规则求值。
	DropProviderNotSupported = "provider_not_supported"
	// DropInvalidRules 表示规则集合不满足领域约束（版本不一致或内容被篡改）。
	DropInvalidRules = "invalid_rules"
	// DropUnknownAccountRef 表示账号引用为空或重复。
	DropUnknownAccountRef = "unknown_account_ref"
)

var (
	// ErrInvalidStoreDependencies 表示 Store 缺少必要依赖。
	ErrInvalidStoreDependencies = errors.New("上游错误规则投影 Store 依赖无效")
	// ErrInvalidProjection 表示投影结构本身非法（整体拒绝）。
	ErrInvalidProjection = errors.New("上游错误规则投影无效")
)

// AccountRules 是一个账号的有效规则集合。
type AccountRules struct {
	accountRef string
	provider   string
	rules      []rulescore.Rule
}

// AccountRef 返回账号引用。
func (account AccountRules) AccountRef() string { return account.accountRef }

// Provider 返回账号所属 Provider。
func (account AccountRules) Provider() string { return account.provider }

// Rules 返回账号的有效规则。
func (account AccountRules) Rules() []rulescore.Rule { return account.rules }

// Drop 是一条被丢弃的账号投影及其原因。
type Drop struct {
	AccountRef string
	Reason     string
}

// ReplaceResult 是一次投影替换的结果。
type ReplaceResult struct {
	Generation int64
	Accepted   []string
	Dropped    []Drop
}

// Options 声明 Store 的能力边界。
type Options struct {
	// SupportedProviders 是 Go 已接入规则求值的 Provider 集合。
	//
	// 空集合表示 Go 尚不承接任何 Provider：所有账号都会被丢弃并继续交还 Node。
	SupportedProviders []string
}

// Store 是进程内的账号规则投影，可安全并发读取。
type Store struct {
	mutex      sync.RWMutex
	supported  map[string]struct{}
	generation int64
	accounts   map[string]AccountRules
	order      []string
}

// NewStore 创建只依赖能力声明的投影存储。
func NewStore(options Options) (*Store, error) {
	supported := make(map[string]struct{}, len(options.SupportedProviders))
	for _, provider := range options.SupportedProviders {
		normalized := normalizeProvider(provider)
		if normalized == "" {
			return nil, ErrInvalidStoreDependencies
		}
		supported[normalized] = struct{}{}
	}
	return &Store{
		supported: supported,
		accounts:  map[string]AccountRules{},
	}, nil
}

// Generation 返回当前投影代次，供推送方确认是否已应用。
func (store *Store) Generation() int64 {
	if store == nil {
		return 0
	}
	store.mutex.RLock()
	defer store.mutex.RUnlock()
	return store.generation
}

// RulesFor 返回账号的有效规则；账号不在投影中时返回 false。
func (store *Store) RulesFor(accountRef string) ([]rulescore.Rule, bool) {
	if store == nil {
		return nil, false
	}
	store.mutex.RLock()
	defer store.mutex.RUnlock()
	account, ok := store.accounts[normalizeRef(accountRef)]
	if !ok {
		return nil, false
	}
	return account.rules, true
}

// Snapshot 返回按账号引用排序的投影副本，供只读诊断使用。
func (store *Store) Snapshot() []AccountRules {
	if store == nil {
		return nil
	}
	store.mutex.RLock()
	defer store.mutex.RUnlock()
	refs := append([]string(nil), store.order...)
	sort.Strings(refs)
	snapshot := make([]AccountRules, 0, len(refs))
	for _, ref := range refs {
		snapshot = append(snapshot, store.accounts[ref])
	}
	return snapshot
}

// SupportedProviders 返回 Go 已接入规则求值的 Provider 集合。
func (store *Store) SupportedProviders() []string {
	if store == nil {
		return nil
	}
	store.mutex.RLock()
	defer store.mutex.RUnlock()
	providers := make([]string, 0, len(store.supported))
	for provider := range store.supported {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	return providers
}
