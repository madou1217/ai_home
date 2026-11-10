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
)

// readStoredCodexCredential 从 Node 的 app-state.db 读取账号归属与原生凭据。
//
// 账号存在性以 account_refs + account_credentials 为准（与 Node accountExists 同口径）；
// native_auth_json 解析失败按空对象处理，交给凭证校验拒绝。
func readStoredCodexCredential(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
) (string, map[string]any, bool, error) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", nil, false, err
	}
	if _, err := os.Stat(databasePath); errors.Is(err, os.ErrNotExist) {
		return "", nil, false, nil
	} else if err != nil {
		return "", nil, false, fmt.Errorf("检查 app-state.db 失败: %w", err)
	}
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return "", nil, false, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	defer func() { _ = db.Close() }()

	var provider string
	var nativeAuthJSON string
	err = db.QueryRowContext(ctx, `
		SELECT r.provider, c.native_auth_json
		FROM account_refs AS r
		INNER JOIN account_credentials AS c ON c.account_ref = r.account_ref
		WHERE r.account_ref = ?
		LIMIT 1`, accountRef).Scan(&provider, &nativeAuthJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", nil, false, nil
		}
		return "", nil, false, fmt.Errorf("读取账号凭据失败: %w", err)
	}
	return strings.ToLower(strings.TrimSpace(provider)), parseNativeAuth(nativeAuthJSON), true, nil
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
