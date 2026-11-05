package sqliteaccount

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ReplaceAccountUIState 覆盖账号页展示状态；账号不存在时不写入。
func (store *Store) ReplaceAccountUIState(
	ctx context.Context,
	state accountcore.UIState,
) error {
	if store == nil || store.db == nil || ctx == nil || !state.IsValid() {
		return accountcore.ErrInvalidUIState
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	result, err := store.db.ExecContext(
		ctx,
		`INSERT INTO account_ui_state (
			account_ref, status, display_name, auth_mode, api_key_mode, base_url, updated_at_ms,
			configured, oauth_pending
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM accounts WHERE account_ref = ?)
		ON CONFLICT(account_ref) DO UPDATE SET
			status = excluded.status,
			display_name = excluded.display_name,
			auth_mode = excluded.auth_mode,
			api_key_mode = excluded.api_key_mode,
			base_url = excluded.base_url,
			updated_at_ms = excluded.updated_at_ms,
			configured = excluded.configured,
			oauth_pending = excluded.oauth_pending`,
		state.AccountRef().String(),
		state.Status(),
		state.DisplayName(),
		state.AuthMode(),
		boolToInt(state.APIKeyMode()),
		state.BaseURL(),
		state.UpdatedAt().UnixMilli(),
		boolToInt(state.Configured()),
		boolToInt(state.OauthPending()),
		state.AccountRef().String(),
	)
	if err != nil {
		return fmt.Errorf("写入账号展示状态失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号展示状态写入结果失败: %w", err)
	}
	if affected == 0 {
		return accountapp.ErrAccountNotFound
	}
	return nil
}

// ListAccountUIStates 返回全部账号展示状态。
func (store *Store) ListAccountUIStates(
	ctx context.Context,
) ([]accountcore.UIState, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, accountapp.ErrInvalidOverview
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rows, err := store.db.QueryContext(
		ctx,
		`SELECT account_ref, status, display_name, auth_mode, api_key_mode, base_url, updated_at_ms,
		        configured, oauth_pending
		   FROM account_ui_state
		  ORDER BY account_ref`,
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号展示状态失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	states := make([]accountcore.UIState, 0, 16)
	for rows.Next() {
		var accountRef, status, displayName, authMode, baseURL string
		var apiKeyMode, configured, oauthPending int
		var updatedAtMS int64
		if err := rows.Scan(
			&accountRef,
			&status,
			&displayName,
			&authMode,
			&apiKeyMode,
			&baseURL,
			&updatedAtMS,
			&configured,
			&oauthPending,
		); err != nil {
			return nil, fmt.Errorf("读取账号展示状态失败: %w", err)
		}
		parsedRef, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		state, err := accountcore.NewUIState(accountcore.UIStateInput{
			AccountRef:  parsedRef,
			Status:      status,
			DisplayName: displayName,
			AuthMode:    authMode,
			APIKeyMode:  apiKeyMode == 1,
			Configured:  configured == 1,
			BaseURL:     baseURL,
			UpdatedAt:   timeFromUnixMilli(updatedAtMS),
		})
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		states = append(states, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号展示状态失败: %w", err)
	}
	return states, nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
