package grokstorage

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
	// ErrUnsupportedCredential 表示凭据不是 Grok 原生 OAuth。
	ErrUnsupportedCredential = errors.New("grok projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("grok projection identity mismatch")
)

const authFile = ".grok/auth.json"

// Materializer 把 Grok 原生凭据写成 CLI 读取的 auth.json，并读取续期结果。
type Materializer struct{}

// ProviderID 返回 Grok 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 只写 auth.json；磁盘已有可用 token 时保持磁盘内容（CLI 可能续期过）。
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
	auth, err := payloadAuth(native.Payload())
	if err != nil || len(auth) == 0 {
		return nil, ErrUnsupportedCredential
	}
	path := filepath.Join(root, authFile)
	if existing, found := readAuthDocument(path); found && hasUsableToken(existing) {
		return nil, nil
	}
	return []accountprojection.ArtifactWrite{{Path: path, Data: auth, Mode: 0o600}}, nil
}

// Capture 读取 auth.json 并重建凭据；身份不一致时报错。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	auth, found := readAuthDocument(filepath.Join(root, authFile))
	if !found || !hasUsableToken(auth) {
		return nil, false, nil
	}
	native, err := json.Marshal(map[string]json.RawMessage{"auth": auth})
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

// ShouldAdopt 只在 JWT iat 更新时回写；无法比较时保留账号库。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	newer, ordered := nextNative.NewerThan(currentNative)
	return ordered && newer
}

// payloadAuth 从 native_auth_json 里取出 CLI 的 auth 文档。
func payloadAuth(payload []byte) (json.RawMessage, error) {
	if len(payload) == 0 {
		return nil, ErrUnsupportedCredential
	}
	var document struct {
		Auth json.RawMessage `json:"auth"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	return document.Auth, nil
}

// readAuthDocument 读取 auth.json；缺失或损坏按不存在处理。
func readAuthDocument(path string) (json.RawMessage, bool) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) || err != nil || len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, false
	}
	if !json.Valid(raw) {
		return nil, false
	}
	return json.RawMessage(raw), true
}

// hasUsableToken 复刻 Node hasGrokOauthTokens：顶层或任一嵌套档案带 key/token 即可用。
func hasUsableToken(document json.RawMessage) bool {
	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil || root == nil {
		return false
	}
	if usableProfile(root) {
		return true
	}
	for _, value := range root {
		if profile, ok := value.(map[string]any); ok && usableProfile(profile) {
			return true
		}
	}
	return false
}

func usableProfile(profile map[string]any) bool {
	for _, key := range []string{"key", "access_token", "accessToken", "refresh_token", "refreshToken"} {
		if value, ok := profile[key].(string); ok && value != "" {
			return true
		}
	}
	return false
}
