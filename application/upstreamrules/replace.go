package upstreamrules

import (
	"sort"
	"strings"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// NewAccountRules 创建一条账号规则投影记录。
func NewAccountRules(
	accountRef string,
	provider string,
	rules []rulescore.Rule,
) AccountRules {
	return AccountRules{
		accountRef: normalizeRef(accountRef),
		provider:   normalizeProvider(provider),
		rules:      rules,
	}
}

// Replace 整体替换投影并返回每个账号的接受结果。
//
// 逐账号判定而不是整体拒绝：被丢弃的账号会出现在 dropped 里，Node 据此继续把该
// 账号的请求交还自己处理，因此部分应用不会让任何账号失去它的异常语义。只有投影
// 结构本身非法（空引用、非法 Provider、超出上限）才整体拒绝并保留原投影。
func (store *Store) Replace(accounts []AccountRules) (ReplaceResult, error) {
	if store == nil {
		return ReplaceResult{}, ErrInvalidStoreDependencies
	}
	if len(accounts) > MaxAccounts {
		return ReplaceResult{}, ErrInvalidProjection
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()

	next := make(map[string]AccountRules, len(accounts))
	accepted := make([]string, 0, len(accounts))
	dropped := make([]Drop, 0)
	for _, account := range accounts {
		ref := normalizeRef(account.accountRef)
		provider := normalizeProvider(account.provider)
		if ref == "" || provider == "" {
			return ReplaceResult{}, ErrInvalidProjection
		}
		if _, exists := next[ref]; exists {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropUnknownAccountRef})
			continue
		}
		if _, supported := store.supported[provider]; !supported {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropProviderNotSupported})
			continue
		}
		rules, err := rulescore.Validate(account.rules)
		if err != nil {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropInvalidRules})
			continue
		}
		next[ref] = AccountRules{accountRef: ref, provider: provider, rules: rules}
		accepted = append(accepted, ref)
	}

	store.generation++
	store.accounts = next
	store.order = accepted
	sort.Strings(accepted)
	return ReplaceResult{
		Generation: store.generation,
		Accepted:   accepted,
		Dropped:    dropped,
	}, nil
}

// normalizeRef 统一账号引用写法。
func normalizeRef(accountRef string) string {
	return strings.TrimSpace(accountRef)
}

// normalizeProvider 统一 Provider 标识写法。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}
