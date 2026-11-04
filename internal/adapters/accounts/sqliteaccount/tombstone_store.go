package sqliteaccount

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	tombstoneKindAccount = "account"
	tombstoneKindAPIKey  = "api_key"
)

// accountTombstoneKey 是稳定账号 ref 的删除标记键。
func accountTombstoneKey(accountRef string) string {
	return "account:" + accountRef
}

// apiKeyTombstoneFingerprint 与 Node 的 api-key-tombstone 同算法：
// sha256(provider + NUL + secret)，只存不可逆指纹。
func apiKeyTombstoneFingerprint(provider, secret string) string {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	trimmedSecret := strings.TrimSpace(secret)
	if normalizedProvider == "" || trimmedSecret == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(normalizedProvider + "\x00" + trimmedSecret))
	return hex.EncodeToString(digest[:])
}

// apiKeyTombstoneKey 是 provider+密钥维度的删除标记键。
func apiKeyTombstoneKey(provider, secret string) string {
	fingerprint := apiKeyTombstoneFingerprint(provider, secret)
	if fingerprint == "" {
		return ""
	}
	return "api_key:" + strings.ToLower(strings.TrimSpace(provider)) + ":" + fingerprint
}

// staticCredentialSecret 只在已知静态凭据类型上取密钥；未知形态返回空串。
func staticCredentialSecret(credential any) string {
	switch value := credential.(type) {
	case *codex.APIKeyAuth:
		return value.APIKey()
	case *claude.APIKeyAuth:
		return value.APIKey()
	case *claude.AuthTokenAuth:
		return value.AuthToken()
	default:
		return ""
	}
}

// writeDeleteTombstones 在删除事务里写账号与静态密钥墓碑；已存在的墓碑保留首次时间。
func writeDeleteTombstones(
	ctx context.Context,
	transaction *sql.Tx,
	accountRef string,
	providerID string,
	credential any,
	nowMS int64,
) error {
	const statement = `
		INSERT INTO account_tombstones (
			tombstone_key, account_ref, provider_id, kind, fingerprint, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(tombstone_key) DO NOTHING`
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		accountTombstoneKey(accountRef),
		accountRef,
		providerID,
		tombstoneKindAccount,
		"",
		nowMS,
	); err != nil {
		return fmt.Errorf("写入账号删除墓碑失败: %w", err)
	}
	secret := staticCredentialSecret(credential)
	fingerprint := apiKeyTombstoneFingerprint(providerID, secret)
	if fingerprint == "" {
		return nil
	}
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		apiKeyTombstoneKey(providerID, secret),
		accountRef,
		providerID,
		tombstoneKindAPIKey,
		fingerprint,
		nowMS,
	); err != nil {
		return fmt.Errorf("写入静态密钥删除墓碑失败: %w", err)
	}
	return nil
}

// IsAccountTombstoned 报告稳定账号 ref 是否被用户删除过；读失败返回错误。
func (store *Store) IsAccountTombstoned(
	ctx context.Context,
	accountRef string,
) (bool, error) {
	if store == nil || store.db == nil || ctx == nil || strings.TrimSpace(accountRef) == "" {
		return false, accountapp.ErrInvalidDeletionRequest
	}
	var exists int
	err := store.db.QueryRowContext(
		ctx,
		"SELECT 1 FROM account_tombstones WHERE tombstone_key = ? LIMIT 1",
		accountTombstoneKey(strings.TrimSpace(accountRef)),
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("读取账号删除墓碑失败: %w", err)
	}
	return true, nil
}

// IsAPIKeyTombstoned 报告 provider+密钥是否被用户删除过；密钥不落库，只比对指纹。
func (store *Store) IsAPIKeyTombstoned(
	ctx context.Context,
	provider string,
	secret string,
) (bool, error) {
	if store == nil || store.db == nil || ctx == nil {
		return false, accountapp.ErrInvalidDeletionRequest
	}
	key := apiKeyTombstoneKey(provider, secret)
	if key == "" {
		return false, nil
	}
	var exists int
	err := store.db.QueryRowContext(
		ctx,
		"SELECT 1 FROM account_tombstones WHERE tombstone_key = ? LIMIT 1",
		key,
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("读取静态密钥删除墓碑失败: %w", err)
	}
	return true, nil
}
