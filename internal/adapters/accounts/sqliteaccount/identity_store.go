package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/identityderive"
)

// ReparseAccountIdentities 从当前凭据重新解析全部账号身份并写入 account_identities。
//
// 这是 identity 的唯一来源：不读取任何历史展示名，也不依赖兼容表。返回写入/删除
// 的行数，供启动日志观察。
func (store *Store) ReparseAccountIdentities(ctx context.Context) (int, error) {
	if store == nil || store.db == nil {
		return 0, fmt.Errorf("账号数据库不可用")
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT a.account_ref, c.credential_json
		  FROM accounts AS a
		  LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref`)
	if err != nil {
		return 0, fmt.Errorf("读取账号凭据失败: %w", err)
	}
	type entry struct {
		ref         string
		credentials string
	}
	entries := make([]entry, 0, 64)
	for rows.Next() {
		var item entry
		var payload sql.NullString
		if err := rows.Scan(&item.ref, &payload); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("读取账号凭据行失败: %w", err)
		}
		item.credentials = payload.String
		entries = append(entries, item)
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("关闭账号凭据结果失败: %w", err)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("读取账号凭据失败: %w", err)
	}

	connection, err := store.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer connection.Close()
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return 0, fmt.Errorf("开始身份重解析事务失败: %w", err)
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	changed := 0
	for _, item := range entries {
		identity, ok := identityderive.Derive([]byte(item.credentials))
		applied, err := applyIdentity(ctx, connection, item.ref, identity, ok)
		if err != nil {
			return 0, err
		}
		if applied {
			changed++
		}
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return 0, fmt.Errorf("提交身份重解析失败: %w", err)
	}
	return changed, nil
}

// RefreshAccountIdentity 重解析单个账号的身份；供注册/改凭据/重新认证后调用。
func (store *Store) RefreshAccountIdentity(ctx context.Context, accountRef string) error {
	ref := strings.TrimSpace(accountRef)
	if store == nil || store.db == nil || ref == "" {
		return nil
	}
	var payload sql.NullString
	err := store.db.QueryRowContext(ctx,
		`SELECT c.credential_json FROM account_credentials AS c WHERE c.account_ref = ?`, ref).
		Scan(&payload)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("读取账号凭据失败: %w", err)
	}
	identity, ok := identityderive.Derive([]byte(payload.String))
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("开始身份刷新事务失败: %w", err)
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	if _, err := applyIdentity(ctx, connection, ref, identity, ok); err != nil {
		return err
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("提交身份刷新失败: %w", err)
	}
	return nil
}

// applyIdentity 写入或删除一行身份事实；返回是否发生变更。
func applyIdentity(
	ctx context.Context,
	connection *sql.Conn,
	accountRef string,
	identity identityderive.Identity,
	found bool,
) (bool, error) {
	if !found || identity.IsEmpty() {
		result, err := connection.ExecContext(ctx,
			`DELETE FROM account_identities WHERE account_ref = ?`, accountRef)
		if err != nil {
			return false, fmt.Errorf("删除账号身份失败: %w", err)
		}
		affected, _ := result.RowsAffected()
		return affected > 0, nil
	}
	now := time.Now().UnixMilli()
	_, err := connection.ExecContext(ctx, `
		INSERT INTO account_identities (
			account_ref, email, phone, nickname, display_name, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_ref) DO UPDATE SET
			email = excluded.email,
			phone = excluded.phone,
			nickname = excluded.nickname,
			display_name = excluded.display_name,
			updated_at_ms = excluded.updated_at_ms`,
		accountRef, identity.Email, identity.Phone, identity.Nickname, identity.DisplayName, now)
	if err != nil {
		return false, fmt.Errorf("写入账号身份失败: %w", err)
	}
	return true, nil
}
