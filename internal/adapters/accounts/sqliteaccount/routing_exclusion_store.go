package sqliteaccount

import (
	"context"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// SetRoutingExclusion 写入账号级 Go 路由排除，并同步刷新进程内路由索引。
//
// 为什么写库和改索引必须在同一把锁里：排除是「Go 永远不选它」的承诺，
// 只落库不刷新索引，本次进程仍然会选中这个账号；只改索引不落库，重启后又把它放回候选。
//
// 账号不存在时返回 accountapp.ErrAccountNotFound：外键失败是这里唯一的可预期失败，
// 调用方（Node 标记自定义上游）需要凭它区分「账号被删了」和「存储坏了」。
func (store *Store) SetRoutingExclusion(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	excluded bool,
	reason string,
	updatedAt time.Time,
) error {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return accountcore.ErrInvalidAccountRef
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	const statement = `
		INSERT INTO account_routing_exclusions (
			account_ref, excluded, reason, updated_at_ms
		) VALUES (?, ?, ?, ?)
		ON CONFLICT (account_ref) DO UPDATE SET
			excluded = excluded.excluded,
			reason = excluded.reason,
			updated_at_ms = excluded.updated_at_ms`
	_, err := store.db.ExecContext(
		ctx,
		statement,
		accountRef.String(),
		excluded,
		reason,
		updatedAt.UTC().UnixMilli(),
	)
	if isForeignKeyError(err) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("写入账号路由排除失败: %w", err)
	}
	store.routes.setRoutingExcluded(accountRef, excluded)
	return nil
}

// LoadRoutingExclusions 返回当前被排除出 Go 路由的账号集合。
//
// 只返回 excluded=1 的行：调用方要的是「谁不能选」，返回全表会让每个调用方
// 各自再判一次 excluded，等于把同一条事实解释两遍。
//
// 表不存在时返回空集合（fail-soft）：旧库升级失败或只读诊断场景下，
// 「没有排除」比让整个账号视图读不出来更安全。
func (store *Store) LoadRoutingExclusions(
	ctx context.Context,
) (map[string]bool, error) {
	if store == nil || store.db == nil || ctx == nil {
		return map[string]bool{}, nil
	}
	rows, err := store.db.QueryContext(
		ctx,
		"SELECT account_ref FROM account_routing_exclusions WHERE excluded = 1",
	)
	if err != nil {
		if isMissingTable(err) {
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("读取账号路由排除失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	exclusions := make(map[string]bool, 16)
	for rows.Next() {
		var accountRef string
		if err := rows.Scan(&accountRef); err != nil {
			return nil, fmt.Errorf("读取账号路由排除行失败: %w", err)
		}
		exclusions[accountRef] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号路由排除失败: %w", err)
	}
	return exclusions, nil
}
