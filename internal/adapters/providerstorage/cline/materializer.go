package clinestorage

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
	// ErrUnsupportedCredential 表示凭据不是 Cline 原生 OAuth。
	ErrUnsupportedCredential = errors.New("cline projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("cline projection identity mismatch")
)

const providersFile = ".cline/data/settings/providers.json"

// Materializer 把 Cline 凭据写成 CLI 读取的 providers.json，并读取续期结果。
type Materializer struct{}

// ProviderID 返回 Cline 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 只写 cline 槽位收窄后的文档；磁盘已有可用 token 时保持磁盘内容。
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
	sanitized, err := nativeaccount.SanitizeClineProvidersDocument(auth)
	if err != nil {
		return nil, ErrUnsupportedCredential
	}
	path := filepath.Join(root, providersFile)
	if existing, found := readDocument(path); found && hasUsableAuth(existing) {
		return nil, nil
	}
	return []accountprojection.ArtifactWrite{{Path: path, Data: sanitized, Mode: 0o600}}, nil
}

// Capture 读取 providers.json（收窄后）并重建凭据；身份不一致时报错。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	document, found := readDocument(filepath.Join(root, providersFile))
	if !found || !hasUsableAuth(document) {
		return nil, false, nil
	}
	sanitized, err := nativeaccount.SanitizeClineProvidersDocument(document)
	if err != nil {
		return nil, false, err
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"auth": sanitized})
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

// ShouldAdopt 只在代际更新时回写；无法比较时保留账号库。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	newer, ordered := nextNative.NewerThan(currentNative)
	return ordered && newer
}

// payloadAuth 从 native_auth_json 里取出 providers.json 文档。
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

// readDocument 读取 JSON 文档；缺失或损坏按不存在处理。
func readDocument(path string) (json.RawMessage, bool) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) || err != nil || len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, false
	}
	if !json.Valid(raw) {
		return nil, false
	}
	return json.RawMessage(raw), true
}

// hasUsableAuth 判断文档的 cline 槽位里是否有可用的 OAuth token。
func hasUsableAuth(document json.RawMessage) bool {
	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil || root == nil {
		return false
	}
	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		return false
	}
	for _, slotID := range []string{"cline", "cline-pass"} {
		slot, _ := providers[slotID].(map[string]any)
		if slot == nil {
			continue
		}
		settings, _ := slot["settings"].(map[string]any)
		if settings == nil {
			settings = slot
		}
		auth, _ := settings["auth"].(map[string]any)
		if auth == nil {
			continue
		}
		for _, key := range []string{"accessToken", "access_token", "refreshToken", "refresh_token"} {
			if value, ok := auth[key].(string); ok && value != "" {
				return true
			}
		}
	}
	return false
}
