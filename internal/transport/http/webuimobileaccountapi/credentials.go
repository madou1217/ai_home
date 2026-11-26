package webuimobileaccountapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"path/filepath"
)

// readStoredCodexCredential 从 aih.db 读取账号归属与原生凭据。
//
// accounts 与 account_credentials 是唯一来源；native_auth_json 解析失败按空对象
// 处理，交给凭证校验拒绝。
func readStoredCodexCredential(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
) (string, map[string]any, bool, error) {
	databasePath := filepath.Join(strings.TrimSpace(aiHomeDir), "aih.db")
	if _, err := os.Stat(databasePath); errors.Is(err, os.ErrNotExist) {
		return "", nil, false, nil
	} else if err != nil {
		return "", nil, false, fmt.Errorf("检查 aih.db 失败: %w", err)
	}
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return "", nil, false, fmt.Errorf("打开 aih.db 失败: %w", err)
	}
	defer func() { _ = db.Close() }()

	var provider string
	var credentialJSON string
	err = db.QueryRowContext(ctx, `
		SELECT a.provider_id, c.credential_json
		FROM accounts AS a
		INNER JOIN account_credentials AS c ON c.account_ref = a.account_ref
		WHERE a.account_ref = ?
		LIMIT 1`, accountRef).Scan(&provider, &credentialJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", nil, false, nil
		}
		return "", nil, false, fmt.Errorf("读取账号凭据失败: %w", err)
	}
	document := map[string]any{}
	_ = json.Unmarshal([]byte(credentialJSON), &document)
	native := map[string]any{}
	if inner, ok := document["native_auth_json"].(map[string]any); ok {
		native = inner
	} else if innerRaw, ok := document["native_auth_json"].(string); ok {
		native = parseNativeAuth(innerRaw)
	} else {
		native = document
	}
	return strings.ToLower(strings.TrimSpace(provider)), native, true, nil
}

func parseNativeAuth(document string) map[string]any {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(document), &parsed); err != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}

// hasCodexOAuthTokens 与 Node hasCodexOAuthTokens 同口径：
// 必须存在 tokens，至少一个 token 非空，且 OPENAI_API_KEY 必须为空。
func hasCodexOAuthTokens(nativeAuth map[string]any) bool {
	auth, _ := nativeAuth["auth"].(map[string]any)
	if auth == nil {
		return false
	}
	if apiKey, _ := auth["OPENAI_API_KEY"].(string); strings.TrimSpace(apiKey) != "" {
		return false
	}
	tokens, _ := auth["tokens"].(map[string]any)
	if tokens == nil {
		return false
	}
	for _, key := range []string{"access_token", "id_token", "refresh_token"} {
		if value, _ := tokens[key].(string); strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}
