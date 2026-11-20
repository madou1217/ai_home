package sqliteaccount

import (
	"context"
	"fmt"
)

// catalogRevisionSQL 汇总所有会改变模型目录内容的账号侧事实。
//
// 它是「目录缓存失效键」的数据库侧唯一事实源：账号/凭据（端点与登录态）、资料、
// UI 镜像地址、模型关系、探测事实、别名的任何写入都会改变其中一项。读取方只需要
// 比较前后两次签名，不必知道具体是哪张表变了。
const catalogRevisionSQL = `
	SELECT
		COALESCE((SELECT MAX(updated_at_ms) FROM accounts), 0),
		(SELECT COUNT(*) FROM accounts),
		COALESCE((SELECT MAX(updated_at_ms) FROM account_credentials), 0),
		(SELECT COUNT(*) FROM account_credentials),
		COALESCE((SELECT MAX(updated_at_ms) FROM account_profiles), 0),
		COALESCE((SELECT MAX(updated_at_ms) FROM account_ui_state), 0),
		COALESCE((SELECT MAX(updated_at_ms) FROM account_models), 0),
		(SELECT COUNT(*) FROM account_models),
		COALESCE((SELECT MAX(updated_at_ms) FROM account_model_probes), 0),
		(SELECT COUNT(*) FROM account_model_probes),
		COALESCE((SELECT MAX(updated_at_ms) FROM model_alias), 0),
		(SELECT COUNT(*) FROM model_alias)`

// CatalogRevision 返回模型目录事实的轻量签名。
//
// 只做有界聚合查询，不读取凭据文档或模型明细；调用方把它当作缓存失效键使用。
func (store *Store) CatalogRevision(ctx context.Context) (string, error) {
	if store == nil || store.db == nil || ctx == nil {
		return "", ErrIncompatibleDatabase
	}
	var (
		accountsUpdatedAt int64
		accountsCount     int64
		credentialsAt     int64
		credentialsCount  int64
		profilesAt        int64
		uiStateAt         int64
		modelsAt          int64
		modelsCount       int64
		probesAt          int64
		probesCount       int64
		aliasesAt         int64
		aliasesCount      int64
	)
	err := store.db.QueryRowContext(ctx, catalogRevisionSQL).Scan(
		&accountsUpdatedAt,
		&accountsCount,
		&credentialsAt,
		&credentialsCount,
		&profilesAt,
		&uiStateAt,
		&modelsAt,
		&modelsCount,
		&probesAt,
		&probesCount,
		&aliasesAt,
		&aliasesCount,
	)
	if err != nil {
		return "", fmt.Errorf("读取模型目录失效键失败: %w", err)
	}
	return fmt.Sprintf(
		"%d:%d|%d:%d|%d|%d|%d:%d|%d:%d|%d:%d",
		accountsUpdatedAt,
		accountsCount,
		credentialsAt,
		credentialsCount,
		profilesAt,
		uiStateAt,
		modelsAt,
		modelsCount,
		probesAt,
		probesCount,
		aliasesAt,
		aliasesCount,
	), nil
}
