package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// routingIndex 是账号模型正排和模型账号倒排的进程内物化读模型。
//
// 征召热读使用原子不可变快照；管理写请求只重建一个账号涉及的模型切片。
type routingIndex struct {
	mu         sync.RWMutex
	accounts   map[accountcore.AccountRef]indexedRoutingAccount
	reverse    map[routingIndexKey][]accountapp.RoutingAccount
	slots      sync.Map
	empty      *accountapp.RoutingCandidates
	observerMu sync.RWMutex
	observer   accountapp.RoutableModelObserver
}

// routeSlot 为单个 Provider、模型元组原子发布最新候选快照。
type routeSlot struct {
	candidates atomic.Pointer[accountapp.RoutingCandidates]
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
			index.replaceAccountDataLocked(current, currentEnabled, currentModels)
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
	index.publishAllSnapshots()
	return index, nil
}

// newRoutingIndex 创建不含账号和模型的并发安全读模型。
func newRoutingIndex() *routingIndex {
	return &routingIndex{
		accounts: make(map[accountcore.AccountRef]indexedRoutingAccount),
		reverse:  make(map[routingIndexKey][]accountapp.RoutingAccount),
		empty:    accountapp.NewRoutingCandidates(nil),
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
	index.replaceAccountAndPublishLocked(account, enabled, models)
	index.mu.Unlock()
	index.notifyRoutableModelsChanged()
}

// replaceAccountAndPublishLocked 更新账号数据并发布全部受影响的路由快照。
func (index *routingIndex) replaceAccountAndPublishLocked(
	account accountapp.RoutingAccount,
	enabled bool,
	models []runtimecore.ModelID,
) {
	affected := make(map[routingIndexKey]struct{}, len(models))
	if previous, found := index.accounts[account.Ref()]; found && previous.enabled {
		for _, modelID := range previous.models {
			key := routingIndexKey{
				providerID: previous.account.ProviderID(),
				modelID:    modelID,
			}
			affected[key] = struct{}{}
		}
	}
	if enabled {
		for _, modelID := range models {
			affected[routingIndexKey{
				providerID: account.ProviderID(),
				modelID:    modelID,
			}] = struct{}{}
		}
	}
	index.replaceAccountDataLocked(account, enabled, models)
	index.publishSnapshotsLocked(affected)
}

// replaceAccountDataLocked 只更新正排和倒排数据，供启动批量构建避免逐账号发布。
func (index *routingIndex) replaceAccountDataLocked(
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
	current, found := index.accounts[accountRef]
	if !found {
		index.mu.Unlock()
		return false
	}
	index.replaceAccountAndPublishLocked(current.account, current.enabled, models)
	index.mu.Unlock()
	index.notifyRoutableModelsChanged()
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
	current, found := index.accounts[account.Ref()]
	if !found {
		index.replaceAccountAndPublishLocked(account, enabled, nil)
		index.mu.Unlock()
		index.notifyRoutableModelsChanged()
		return
	}
	index.replaceAccountAndPublishLocked(account, enabled, current.models)
	index.mu.Unlock()
	index.notifyRoutableModelsChanged()
}

// publishAllSnapshots 在启动加载完成后一次性发布全部路由，避免逐账号复制大切片。
func (index *routingIndex) publishAllSnapshots() {
	if index == nil {
		return
	}
	for key := range index.reverse {
		index.publishSnapshotLocked(key)
	}
}

// publishSnapshotsLocked 为一次管理写涉及的路由发布新不可变快照。
func (index *routingIndex) publishSnapshotsLocked(
	keys map[routingIndexKey]struct{},
) {
	for key := range keys {
		index.publishSnapshotLocked(key)
	}
}

// publishSnapshotLocked 复制一次最终倒排切片并原子替换热读指针。
func (index *routingIndex) publishSnapshotLocked(key routingIndexKey) {
	value, _ := index.slots.LoadOrStore(key, &routeSlot{})
	slot := value.(*routeSlot)
	slot.candidates.Store(accountapp.NewRoutingCandidates(index.reverse[key]))
}

// loadCandidates 无锁读取单个 Provider、模型元组的当前不可变快照。
func (index *routingIndex) loadCandidates(
	ctx context.Context,
	providerID string,
	modelID runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	if index == nil ||
		ctx == nil ||
		providerID == "" ||
		!modelID.IsValid() {
		return nil, accountapp.ErrInvalidRoutingQuery
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	value, found := index.slots.Load(routingIndexKey{
		providerID: providerID,
		modelID:    modelID,
	})
	if !found {
		return index.empty, nil
	}
	candidates := value.(*routeSlot).candidates.Load()
	if candidates == nil {
		return index.empty, nil
	}
	return candidates, nil
}

// setRoutableModelObserver 注册唯一的进程内目录变化观察端口。
func (index *routingIndex) setRoutableModelObserver(
	observer accountapp.RoutableModelObserver,
) {
	if index == nil {
		return
	}
	index.observerMu.Lock()
	index.observer = observer
	index.observerMu.Unlock()
}

// notifyRoutableModelsChanged 在路由索引写锁外发送快速变化通知。
func (index *routingIndex) notifyRoutableModelsChanged() {
	if index == nil {
		return
	}
	index.observerMu.RLock()
	observer := index.observer
	index.observerMu.RUnlock()
	if observer != nil {
		observer.RoutableModelsChanged()
	}
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
