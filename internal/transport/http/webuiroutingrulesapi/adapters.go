package webuiroutingrulesapi

import (
	"context"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

// 编译期确认现成适配器满足 Handler 端口，接线时不需要再包一层。
var (
	_ RulesStore    = (*rulesenv.Store)(nil)
	_ AccountLedger = (*sqliteaccount.Store)(nil)
)

// AccountLedger 是 Go 账号台账（aih.db）的最小读取端口。
//
// 只暴露按 ref 取账号快照，避免本包依赖账号仓储的写能力；*sqliteaccount.Store
// 直接满足该接口。
type AccountLedger interface {
	GetByRef(ctx context.Context, accountRef accountcore.AccountRef) (accountcore.Account, error)
}

// LedgerResolver 先查 Node 的 account_refs，未命中再回退 Go 的 accounts 表。
//
// 两份台账解决的是不同缺口：account_refs 是 Node 时代账号的权威存在性证据，
// Go 的 accounts 表则覆盖只在 Go 侧登记、尚未同步回 Node 的账号。AppState 返回
// 的 Provider 优先，因为同一账号在两个台账里的归属冲突时，Node 侧才是调度规则
// 读侧的取值来源。
type LedgerResolver struct {
	DatabasePath string
	Ledger       AccountLedger
}

// ProviderOf 实现 AccountResolver。
func (resolver LedgerResolver) ProviderOf(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	provider, found, err := AppStateResolver{DatabasePath: resolver.DatabasePath}.ProviderOf(ctx, accountRef)
	if err != nil || found || resolver.Ledger == nil {
		return provider, found, err
	}
	reference, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		// 非规范 ref 不可能存在于 Go 的 accounts 表；按未命中处理，不把路径
		// 校验问题伪装成存储故障。
		return "", false, nil
	}
	account, err := resolver.Ledger.GetByRef(ctx, reference)
	if errors.Is(err, accountapp.ErrAccountNotFound) || errors.Is(err, accountcore.ErrInvalidAccountRef) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return account.ProviderID(), true, nil
}

// Adapters 汇总调度规则写入所需的本地适配器。
type Adapters struct {
	Store    *rulesenv.Store
	Accounts AccountResolver
}

// OpenAdapters 打开 aiHomeDir/app-state.db 上的规则写入口，并构造账号解析器。
//
// ledger 可为 nil：此时只按 Node 的 account_refs 判断账号存在性。装配方通常传入
// 同一个进程里已打开的 *sqliteaccount.Store。
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
