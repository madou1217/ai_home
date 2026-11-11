// Package projection 把刷新后的 agy 凭据同步到运行投影目录。
//
// Node 在 agy 刷新成功后做两件事：写回凭据账本，再把新 token 物化到
// run/auth-projections/agy/<accountRef>。Go 接管刷新后只写账本时，已经启动的
// CLI 会话与账号配置文件页仍看到旧 token；这里补齐与 Node 相同的物化步骤。
package projection

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

// ErrInvalidInput 表示缺少数据根、账号引用或凭据。
var ErrInvalidInput = errors.New("agy 投影参数无效")

const (
	oauthCredsFile     = ".gemini/oauth_creds.json"
	antigravityToken   = ".gemini/antigravity-cli/antigravity-oauth-token"
	jetskiToken        = ".gemini/jetski-standalone-oauth-token"
	googleAccountsFile = ".gemini/google_accounts.json"
	emailCacheFile     = ".gemini/antigravity-cli/email.cache"
	authMethodConsumer = "consumer"
	projectionFileMode = 0o600
	projectionDirMode  = 0o700
)

// Write 把新 token 合并进运行投影的三份文件。
//
// 目录不存在表示账号还没有启动过运行时；此时不创建目录——Node 会在启动时按
// 账本重新物化，提前造一份投影反而可能和宿主物化逻辑打架。
func Write(aiHomeDir string, accountRef string, auth *agy.OAuthAuth) error {
	if aiHomeDir == "" || accountRef == "" || auth == nil {
		return ErrInvalidInput
	}
	runtimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
	if info, err := os.Stat(runtimeDir); err != nil || !info.IsDir() {
		return nil
	}
	expiresAtMS := auth.ExpiresAtMS()
	refreshedAtMS := auth.RefreshedAtMS()
	expiresAt := time.UnixMilli(expiresAtMS).UTC()
	expiresIn := int64(0)
	if expiresAtMS > refreshedAtMS {
		expiresIn = (expiresAtMS - refreshedAtMS) / 1000
	}
	if err := mergeJSONFile(filepath.Join(runtimeDir, oauthCredsFile), map[string]any{
		"access_token":  auth.AccessToken(),
		"refresh_token": auth.RefreshToken(),
		"token_type":    auth.TokenType(),
		"expiry_date":   expiresAtMS,
	}); err != nil {
		return err
	}
	// 账号邮箱变化（re-key）后，CLI 的账号列表与邮箱缓存也必须跟着变，
	// 否则界面/选号仍显示旧邮箱。
	if err := mergeJSONFile(filepath.Join(runtimeDir, googleAccountsFile), map[string]any{
		"active": auth.Email(),
	}); err != nil {
		return err
	}
	if err := writeTextFile(filepath.Join(runtimeDir, emailCacheFile), auth.Email()); err != nil {
		return err
	}
	if err := mergeJSONFile(filepath.Join(runtimeDir, antigravityToken), map[string]any{
		"auth_method":    authMethodConsumer,
		"id_token_email": auth.Email(),
		"token": map[string]any{
			"access_token":  auth.AccessToken(),
			"refresh_token": auth.RefreshToken(),
			"token_type":    auth.TokenType(),
			"expiry":        expiresAt.Format(time.RFC3339Nano),
			"expires_in":    expiresIn,
		},
	}); err != nil {
		return err
	}
	return mergeJSONFile(filepath.Join(runtimeDir, jetskiToken), map[string]any{
		"auth_method": authMethodConsumer,
		"token": map[string]any{
			"access_token":    auth.AccessToken(),
			"refresh_token":   auth.RefreshToken(),
			"token_type":      auth.TokenType(),
			"expires_at_ms":   expiresAtMS,
			"expiry":          expiresAt.Format(time.RFC3339Nano),
			"refreshed_at_ms": refreshedAtMS,
		},
	})
}

// mergeJSONFile 只覆盖给定字段，保留上游客户端写在文件里的其它键（scope 等）。
func mergeJSONFile(path string, patch map[string]any) error {
	document := make(map[string]any)
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &document); err != nil {
			document = make(map[string]any)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	mergeDocument(document, patch)
	return writeJSONFile(path, document)
}

func mergeDocument(document map[string]any, patch map[string]any) {
	for key, value := range patch {
		if nested, ok := value.(map[string]any); ok {
			child, _ := document[key].(map[string]any)
			if child == nil {
				child = make(map[string]any)
			}
			mergeDocument(child, nested)
			document[key] = child
			continue
		}
		document[key] = value
	}
}

// writeTextFile 原子写入纯文本投影（email.cache 等）。
func writeTextFile(path string, value string) error {
	if err := os.MkdirAll(filepath.Dir(path), projectionDirMode); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agy-projection-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(projectionFileMode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(value); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func writeJSONFile(path string, document map[string]any) error {
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), projectionDirMode); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agy-projection-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(projectionFileMode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
