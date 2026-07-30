package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// routingIndex 是账号模型正排和模型账号倒排的进程内物化读模型。
//
// 读请求只持有共享锁并复制有界结果；写请求只更新一个账号涉及的模型切片。
type routingIndex struct {
	mu       sync.RWMutex
	accounts map[accountcore.AccountRef]indexedRoutingAccount
	reverse  map[routingIndexKey][]accountapp.RoutingAccount
}

// indexedRoutingAccount 保存账号启停状态及排序后的有效模型正排。
type indexedRoutingAccount struct {
	account accountapp.RoutingAccount
	enabled bool
	models  []runtimecore.ModelID
}

// routingIndexKey 是 Provider 与真实模型组成的倒排键。
type routingIndexKey struct {
	providerID string
	modelID    runtimecore.ModelID
}

// loadRoutingIndex 从公开账号字段和模型关系构建启动时唯一完整快照。
func (store *Store) loadRoutingIndex(ctx context.Context) (*routingIndex, error) {
	const query = `
		SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
		       m.model_id, m.upstream_available, m.manual_policy, m.updated_at_ms
		FROM accounts AS a
		LEFT JOIN account_models AS m ON m.account_ref = a.account_ref
		ORDER BY a.account_ref, m.model_id`
	rows, err := store.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("加载账号模型路由索引失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	index := newRoutingIndex()
	var currentRef accountcore.AccountRef
	var current accountapp.RoutingAccount
	var currentEnabled bool
	var currentModels []runtimecore.ModelID
	flush := func() {
		if currentRef.IsValid() {
			index.replaceAccount(current, currentEnabled, currentModels)
		}
	}
	for rows.Next() {
		var (
			accountRefText string
			providerID     string
			cliAccountID   int64
			enabled        bool
			modelIDText    sql.NullString
			upstream       sql.NullBool
			manualPolicy   sql.NullString
			updatedAtMS    sql.NullInt64
		)
		if err := rows.Scan(
			&accountRefText,
			&providerID,
			&cliAccountID,
			&enabled,
			&modelIDText,
			&upstream,
			&manualPolicy,
			&updatedAtMS,
		); err != nil {
			return nil, fmt.Errorf("读取账号模型路由索引失败: %w", err)
		}
		accountRef, account, err := restoreIndexedRoutingAccount(
			store.catalog,
			accountRefText,
			providerID,
			cliAccountID,
		)
		if err != nil {
			return nil, err
		}
		if currentRef != "" && accountRef != currentRef {
			flush()
			currentModels = nil
		}
		if accountRef != currentRef {
			currentRef = accountRef
			current = account
			currentEnabled = enabled
		}
		if !modelIDText.Valid {
			if upstream.Valid || manualPolicy.Valid || updatedAtMS.Valid {
				return nil, ErrIncompatibleDatabase
			}
			continue
		}
		if !upstream.Valid || !manualPolicy.Valid || !updatedAtMS.Valid {
			return nil, ErrIncompatibleDatabase
		}
		policy, err := accountapp.ParseModelManualPolicy(manualPolicy.String)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           modelIDText.String,
			UpstreamAvailable: upstream.Bool,
			ManualPolicy:      policy,
			UpdatedAt:         time.UnixMilli(updatedAtMS.Int64).UTC(),
		})
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		if model.Effective() {
			currentModels = append(currentModels, model.ModelID())
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号模型路由索引失败: %w", err)
	}
	flush()
	return index, nil
}

// newRoutingIndex 创建不含账号和模型的并发安全读模型。
func newRoutingIndex() *routingIndex {
	return &routingIndex{
		accounts: make(map[accountcore.AccountRef]indexedRoutingAccount),
		reverse:  make(map[routingIndexKey][]accountapp.RoutingAccount),
	}
}

// replaceAccount 原子替换一个账号的正排，并增量维护受影响倒排切片。
func (index *routingIndex) replaceAccount(
	account accountapp.RoutingAccount,
	enabled bool,
	models []runtimecore.ModelID,
) {
	if index == nil {
		return
	}
	index.mu.Lock()
	defer index.mu.Unlock()
	index.replaceAccountLocked(account, enabled, models)
}

// replaceAccountLocked 在唯一写锁内同时更新账号正排和所有受影响倒排。
func (index *routingIndex) replaceAccountLocked(
	account accountapp.RoutingAccount,
	enabled bool,
	models []runtimecore.ModelID,
) {
	if previous, found := index.accounts[account.Ref()]; found && previous.enabled {
		for _, modelID := range previous.models {
			key := routingIndexKey{
				providerID: previous.account.ProviderID(),
				modelID:    modelID,
			}
			index.reverse[key] = removeRoutingAccount(
				index.reverse[key],
				previous.account.Ref(),
			)
			if len(index.reverse[key]) == 0 {
				delete(index.reverse, key)
			}
		}
	}
	index.accounts[account.Ref()] = indexedRoutingAccount{
		account: account,
		enabled: enabled,
		models:  append([]runtimecore.ModelID(nil), models...),
	}
	if !enabled {
		return
	}
	for _, modelID := range models {
		key := routingIndexKey{
			providerID: account.ProviderID(),
			modelID:    modelID,
		}
		index.reverse[key] = insertRoutingAccount(index.reverse[key], account)
	}
}

// replaceModels 保留账号身份和启停状态，仅替换有效模型正排。
func (index *routingIndex) replaceModels(
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
) bool {
	if index == nil {
		return false
	}
	index.mu.Lock()
	defer index.mu.Unlock()
	current, found := index.accounts[accountRef]
	if !found {
		return false
	}
	index.replaceAccountLocked(current.account, current.enabled, models)
	return true
}

// setAccount 更新账号启停状态并保留当前模型正排。
func (index *routingIndex) setAccount(
	account accountapp.RoutingAccount,
	enabled bool,
) {
	if index == nil {
		return
	}
	index.mu.Lock()
	defer index.mu.Unlock()
	current, found := index.accounts[account.Ref()]
	if !found {
		index.replaceAccountLocked(account, enabled, nil)
		return
	}
	index.replaceAccountLocked(account, enabled, current.models)
}

// list 使用二分游标从本地倒排返回有界账号候选。
func (index *routingIndex) list(
	ctx context.Context,
	query accountapp.RoutingQuery,
) ([]accountapp.RoutingAccount, error) {
	if index == nil || ctx == nil {
		return nil, accountapp.ErrInvalidRoutingQuery
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := routingIndexKey{
		providerID: query.ProviderID(),
		modelID:    query.ModelID(),
	}
	index.mu.RLock()
	accounts := index.reverse[key]
	start := sort.Search(len(accounts), func(position int) bool {
		return accounts[position].Ref().String() > query.AfterRef().String()
	})
	end := min(start+query.Limit(), len(accounts))
	result := append([]accountapp.RoutingAccount(nil), accounts[start:end]...)
	index.mu.RUnlock()
	return result, nil
}

// listModels 返回至少有一个启用账号的排序 Provider 模型元组。
func (index *routingIndex) listModels(
	ctx context.Context,
	catalog *providers.Catalog,
) ([]accountapp.RoutableModel, error) {
	if index == nil || catalog == nil || ctx == nil {
		return nil, accountapp.ErrInvalidRoutableModel
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	index.mu.RLock()
	keys := make([]routingIndexKey, 0, len(index.reverse))
	for key, accounts := range index.reverse {
		if len(accounts) > 0 {
			keys = append(keys, key)
		}
	}
	index.mu.RUnlock()
	sort.Slice(keys, func(left int, right int) bool {
		if keys[left].modelID != keys[right].modelID {
			return keys[left].modelID.String() < keys[right].modelID.String()
		}
		return keys[left].providerID < keys[right].providerID
	})
	models := make([]accountapp.RoutableModel, 0, len(keys))
	for _, key := range keys {
		model, err := accountapp.NewRoutableModel(
			catalog,
			key.providerID,
			key.modelID.String(),
		)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		models = append(models, model)
	}
	return models, nil
}

// insertRoutingAccount 按 AccountRef 插入，避免同账号重复进入倒排。
func insertRoutingAccount(
	accounts []accountapp.RoutingAccount,
	account accountapp.RoutingAccount,
) []accountapp.RoutingAccount {
	position := sort.Search(len(accounts), func(index int) bool {
		return accounts[index].Ref().String() >= account.Ref().String()
	})
	if position < len(accounts) && accounts[position].Ref() == account.Ref() {
		accounts[position] = account
		return accounts
	}
	accounts = append(accounts, accountapp.RoutingAccount{})
	copy(accounts[position+1:], accounts[position:])
	accounts[position] = account
	return accounts
}

// removeRoutingAccount 按 AccountRef 删除一个倒排条目。
func removeRoutingAccount(
	accounts []accountapp.RoutingAccount,
	accountRef accountcore.AccountRef,
) []accountapp.RoutingAccount {
	position := sort.Search(len(accounts), func(index int) bool {
		return accounts[index].Ref().String() >= accountRef.String()
	})
	if position == len(accounts) || accounts[position].Ref() != accountRef {
		return accounts
	}
	copy(accounts[position:], accounts[position+1:])
	accounts[len(accounts)-1] = accountapp.RoutingAccount{}
	return accounts[:len(accounts)-1]
}

// restoreIndexedRoutingAccount 校验启动查询中的紧凑账号字段。
func restoreIndexedRoutingAccount(
	catalog *providers.Catalog,
	accountRefText string,
	providerID string,
	cliAccountID int64,
) (accountcore.AccountRef, accountapp.RoutingAccount, error) {
	accountRef, refErr := accountcore.ParseAccountRef(accountRefText)
	alias, aliasErr := accountcore.NewCLIAccountID(cliAccountID)
	if refErr != nil || aliasErr != nil {
		return "", accountapp.RoutingAccount{}, ErrIncompatibleDatabase
	}
	account, err := accountapp.NewRoutingAccount(catalog, accountapp.RoutingAccountInput{
		Ref:          accountRef,
		ProviderID:   providerID,
		CLIAccountID: alias,
	})
	if err != nil {
		return "", accountapp.RoutingAccount{}, ErrIncompatibleDatabase
	}
	return accountRef, account, nil
}
