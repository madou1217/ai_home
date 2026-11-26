package webuiroutingrulesapi

import (
	"context"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// 编译期确认现成适配器满足 Handler 端口，接线时不需要再包一层。
var (
	_ AccountLedger           = (*sqliteaccount.Store)(nil)
	_ AccountIdentityResolver = LedgerResolver{}
	_ GoRulesSyncer           = LedgerResolver{}
)

// AccountLedger 是 Go 账号台账（aih.db）的最小读取端口。
//
// *sqliteaccount.Store 直接满足该接口。
type AccountLedger interface {
	GetByRef(ctx context.Context, accountRef accountcore.AccountRef) (accountcore.Account, error)
}

// LedgerResolver 统一解析账号身份（支持 Go 原生账号与历史映射账号），并在 Ledger 为
// *sqliteaccount.Store 时将账号级上游错误规则直接同步落入 aih.db，确保网关运行态单源真值立即生效。
type LedgerResolver struct {
	Ledger AccountLedger
}

// ProviderOf 实现 AccountResolver。
func (resolver LedgerResolver) ProviderOf(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	provider, _, _, exists, err := resolver.ResolveAccountIdentity(ctx, accountRef)
	return provider, exists, err
}

// ResolveAccountIdentity 解析账号归属 Provider 与规范 Go 引用。
func (resolver LedgerResolver) ResolveAccountIdentity(
	ctx context.Context,
	accountRef string,
) (string, string, string, bool, error) {
	trimmed := strings.TrimSpace(accountRef)
	if trimmed == "" || resolver.Ledger == nil {
		return "", "", "", false, nil
	}
	parsed, err := accountcore.ParseAccountRef(trimmed)
	if err != nil {
		return "", "", "", false, nil
	}
	account, getErr := resolver.Ledger.GetByRef(ctx, parsed)
	if errors.Is(getErr, accountapp.ErrAccountNotFound) || errors.Is(getErr, accountcore.ErrInvalidAccountRef) {
		return "", "", "", false, nil
	}
	if getErr != nil {
		return "", "", "", false, getErr
	}
	return account.ProviderID(), parsed.String(), parsed.String(), true, nil
}

// SyncAccountRules 将账号自身规则与挂载组顺序原子写入 aih.db（网关求值的唯一权威真值源）。
//
// 返回值 synced=false 表示 Ledger 未装配为 SQLite 仓储或该历史账号尚未进入 aih.db。
func (resolver LedgerResolver) SyncAccountRules(
	ctx context.Context,
	goRef string,
	rules []rulescore.Rule,
	groupIDs []string,
) (bool, error) {
	sqliteStore, ok := resolver.Ledger.(*sqliteaccount.Store)
	if !ok || sqliteStore == nil || strings.TrimSpace(goRef) == "" {
		return false, nil
	}
	repository := sqliteaccount.NewUpstreamErrorRuleRepository(sqliteStore)
	provider, exists, err := repository.AccountProvider(ctx, goRef)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	if err := repository.ReplaceAccount(ctx, rulesapp.Record{
		AccountRef: goRef,
		Provider:   strings.ToLower(strings.TrimSpace(provider)),
		GroupIDs:   groupIDs,
		Rules:      rules,
	}); err != nil {
		return false, err
	}
	return true, nil
}

func uniqueNonEmptyStrings(values ...string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// Adapters 汇总调度规则写入所需的本地适配器。
type Adapters struct {
	Accounts AccountResolver
}

// OpenAdapters 构造账号解析与 aih.db 规则同步器。
func OpenAdapters(ctx context.Context, aiHomeDir string, ledger AccountLedger) (*Adapters, error) {
	_ = ctx
	_ = aiHomeDir
	return &Adapters{
		Accounts: LedgerResolver{Ledger: ledger},
	}, nil
}

// Close 释放规则写入口的数据库连接。
func (adapters *Adapters) Close() error {
	return nil
}
