package agystorage

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 Antigravity OAuth。
	ErrUnsupportedCredential = errors.New("agy projection requires oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("agy projection identity mismatch")
)

const (
	tokenFile      = ".gemini/antigravity-cli/antigravity-oauth-token"
	emailCacheFile = ".gemini/antigravity-cli/email.cache"
)

// Materializer 把 Antigravity OAuth 凭据写成 CLI 读取的五份投影文件。
type Materializer struct{}

// ProviderID 返回 Antigravity 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 直接调用 agy 投影写入器（它已经做了原子写、合并与派生文件）。
func (Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	auth, ok := request.Credential.(*agy.OAuthAuth)
	if !ok || auth == nil {
		return nil, ErrUnsupportedCredential
	}
	if err := agyprojection.WriteRuntimeDir(root, auth); err != nil {
		return nil, err
	}
	return nil, nil
}

// Capture 读取 CLI 落盘的 token/email 并重建凭据；身份不一致时报错。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	token, ok := readJSONDocument(filepath.Join(root, tokenFile))
	if !ok {
		return nil, false, nil
	}
	email := strings.TrimSpace(stringField(token, "id_token_email"))
	if email == "" {
		if raw, err := os.ReadFile(filepath.Join(root, emailCacheFile)); err == nil {
			email = strings.TrimSpace(string(raw))
		}
	}
	native, err := json.Marshal(map[string]any{"email": email, "oauthToken": json.RawMessage(token)})
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": native})
	if err != nil {
		return nil, false, err
	}
	next, _, err := nativeaccount.NewDecoder().Decode(ProviderID, envelope)
	if err != nil {
		return nil, false, err
	}
	nextAuth, ok := next.(*agy.OAuthAuth)
	if !ok || nextAuth == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current, ok := request.Credential.(*agy.OAuthAuth); ok && current != nil {
		if current.IdentitySeed() != nextAuth.IdentitySeed() {
			return nil, false, ErrIdentityMismatch
		}
	}
	return nextAuth, true, nil
}

// ShouldAdopt 只在 access token 过期时间更晚时回写（agy 的刷新只延长 expiry）。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentAuth, currentOK := current.(*agy.OAuthAuth)
	nextAuth, nextOK := next.(*agy.OAuthAuth)
	if !currentOK || !nextOK || currentAuth == nil || nextAuth == nil {
		return false
	}
	if currentAuth.IdentitySeed() != nextAuth.IdentitySeed() {
		return false
	}
	return nextAuth.ExpiresAtMS() > currentAuth.ExpiresAtMS()
}

// readJSONDocument 读取 JSON 对象；缺失或损坏按不存在处理。
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

func stringField(document json.RawMessage, key string) string {
	var object map[string]any
	if err := json.Unmarshal(document, &object); err != nil {
		return ""
	}
	value, _ := object[key].(string)
	return value
}
