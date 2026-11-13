package geministorage

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 Gemini 原生 OAuth。
	ErrUnsupportedCredential = errors.New("gemini projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("gemini projection identity mismatch")
)

const (
	oauthCredsFile     = "oauth_creds.json"
	googleAccountsFile = "google_accounts.json"
	nativeRootDir      = ".gemini"
)

// Materializer 把 Gemini 原生凭据写成官方 CLI 读取的两份文件，并读取续期结果。
type Materializer struct{}

// ProviderID 返回 Gemini 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 只编码官方文件，不落盘；Provisioner 负责权限与原子替换。
//
// Gemini CLI 会原地续期 oauth_creds.json：磁盘上已有可用的 access_token 时保持
// 磁盘内容（可能比账号快照新），退出后由 Capture 追平账号库。
func (Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	native, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != ProviderID {
		return nil, ErrUnsupportedCredential
	}
	oauthCreds, googleAccounts, err := splitPayload(native.Payload())
	if err != nil || len(oauthCreds) == 0 {
		return nil, ErrUnsupportedCredential
	}
	oauthPath := filepath.Join(root, nativeRootDir, oauthCredsFile)
	if _, found := readOAuthDocument(oauthPath); found {
		return nil, nil
	}
	writes := []accountprojection.ArtifactWrite{{
		Path: oauthPath,
		Data: oauthCreds,
		Mode: 0o600,
	}}
	if len(googleAccounts) > 0 {
		writes = append(writes, accountprojection.ArtifactWrite{
			Path: filepath.Join(root, nativeRootDir, googleAccountsFile),
			Data: googleAccounts,
			Mode: 0o600,
		})
	}
	return writes, nil
}

// Capture 读取 CLI 落盘的 oauth_creds.json / google_accounts.json 并重建凭据。
//
// 缺少 google_accounts.json 时身份不可验证，按「没有变化」处理，绝不猜身份。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	oauthCreds, ok := readOAuthDocument(filepath.Join(root, nativeRootDir, oauthCredsFile))
	if !ok {
		return nil, false, nil
	}
	googleAccounts, hasAccounts := readJSONDocument(filepath.Join(root, nativeRootDir, googleAccountsFile))
	if !hasAccounts {
		return nil, false, nil
	}
	payload, err := json.Marshal(map[string]json.RawMessage{
		"oauthCreds":     oauthCreds,
		"googleAccounts": googleAccounts,
	})
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
	if err != nil {
		return nil, false, err
	}
	next, _, err := nativeaccount.NewDecoder().Decode(ProviderID, envelope)
	if err != nil {
		return nil, false, err
	}
	nextNative, ok := next.(*accountcore.NativeCredential)
	if !ok || nextNative == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current, ok := request.Credential.(*accountcore.NativeCredential); ok && current != nil {
		if current.IdentitySeed() != nextNative.IdentitySeed() {
			return nil, false, ErrIdentityMismatch
		}
	}
	return nextNative, true, nil
}

// ShouldAdopt 只在代际（expiry_date）更新时回写；无法比较时保留账号库。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	newer, ordered := nextNative.NewerThan(currentNative)
	return ordered && newer
}

// splitPayload 从 native_auth_json 里取出两份官方文档的原始字节。
func splitPayload(payload []byte) (json.RawMessage, json.RawMessage, error) {
	if len(payload) == 0 {
		return nil, nil, ErrUnsupportedCredential
	}
	var document struct {
		OAuthCreds     json.RawMessage `json:"oauthCreds"`
		GoogleAccounts json.RawMessage `json:"googleAccounts"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, nil, err
	}
	return document.OAuthCreds, document.GoogleAccounts, nil
}

// readOAuthDocument 读取 oauth_creds.json：缺失或没有 token 时按不可用处理。
func readOAuthDocument(path string) (json.RawMessage, bool) {
	raw, ok := readJSONDocument(path)
	if !ok {
		return nil, false
	}
	var document struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, false
	}
	if document.AccessToken == "" && document.RefreshToken == "" {
		return nil, false
	}
	return raw, true
}

// readJSONDocument 读取 JSON 对象；缺失、损坏或非对象都按不存在处理。
func readJSONDocument(path string) (json.RawMessage, bool) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) || err != nil || len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, false
	}
	if !json.Valid(raw) {
		return nil, false
	}
	return json.RawMessage(raw), true
}
