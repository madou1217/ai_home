package webuiroutingrulesapi

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

// 编译期确认现成适配器满足 Handler 端口，接线时不需要再包一层。
var (
	_ RulesStore              = (*rulesenv.Store)(nil)
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
	DatabasePath string
	Ledger       AccountLedger
}

// ProviderOf 实现 AccountResolver。
func (resolver LedgerResolver) ProviderOf(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	provider, _, _, exists, err := resolver.ResolveAccountIdentity(ctx, accountRef)
	return provider, exists, err
}

// ResolveAccountIdentity 同时解析账号归属 Provider、规范 Go 引用与历史 app-state 引用。
func (resolver LedgerResolver) ResolveAccountIdentity(
	ctx context.Context,
	accountRef string,
) (string, string, string, bool, error) {
	trimmed := strings.TrimSpace(accountRef)
	if trimmed == "" {
		return "", "", "", false, nil
	}

	var refTable accountrefmap.Table
	if strings.TrimSpace(resolver.DatabasePath) != "" {
		if loaded, err := accountrefmap.Load(ctx, filepath.Dir(resolver.DatabasePath)); err == nil {
			refTable = loaded
		}
	}
	goRef := refTable.GoRef(trimmed)
	if goRef == "" {
		goRef = trimmed
	}
	nodeRef := refTable.NodeRef(trimmed)
	if nodeRef == "" {
		nodeRef = trimmed
	}

	// 1. 优先从 Go 权威账号台账（aih.db）确认存在性与 Provider。
	if resolver.Ledger != nil {
		for _, candidate := range uniqueNonEmptyStrings(goRef, trimmed) {
			parsed, err := accountcore.ParseAccountRef(candidate)
			if err != nil {
				continue
			}
			account, getErr := resolver.Ledger.GetByRef(ctx, parsed)
			if errors.Is(getErr, accountapp.ErrAccountNotFound) || errors.Is(getErr, accountcore.ErrInvalidAccountRef) {
				continue
			}
			if getErr != nil {
				return "", "", "", false, getErr
			}
			mappedNode := refTable.NodeRef(parsed.String())
			if mappedNode == "" {
				mappedNode = parsed.String()
			}
			return account.ProviderID(), parsed.String(), mappedNode, true, nil
		}
	}

	// 2. 回退查询 app-state.db（含其对同目录 aih.db 的兜底读取），兼容已停用/未同步的历史账号。
	if strings.TrimSpace(resolver.DatabasePath) != "" {
		for _, candidate := range uniqueNonEmptyStrings(trimmed, nodeRef, goRef) {
			provider, found, err := AppStateResolver{DatabasePath: resolver.DatabasePath}.ProviderOf(ctx, candidate)
			if err != nil {
				return "", "", "", false, err
			}
			if found {
				return provider, goRef, nodeRef, true, nil
			}
		}
	}

	return "", "", "", false, nil
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
	Store    *rulesenv.Store
	Accounts AccountResolver
}

// OpenAdapters 打开 aiHomeDir/app-state.db 上的规则写入口，并构造账号解析与 aih.db 规则同步器。
func OpenAdapters(ctx context.Context, aiHomeDir string, ledger AccountLedger) (*Adapters, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	store, err := rulesenv.Open(ctx, path)
	if err != nil {
		return nil, err
	}
	return &Adapters{
		Store: store,
		Accounts: LedgerResolver{
			DatabasePath: path,
			Ledger:       ledger,
		},
	}, nil
}

// Close 释放规则写入口的数据库连接。
func (adapters *Adapters) Close() error {
	if adapters == nil || adapters.Store == nil {
		return nil
	}
	return adapters.Store.Close()
}
