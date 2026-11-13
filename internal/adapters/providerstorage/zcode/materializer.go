package zcodestorage

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 ZCode 原生 OAuth。
	ErrUnsupportedCredential = errors.New("zcode projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("zcode projection identity mismatch")
)

const (
	credentialsFile = ".zcode/v2/credentials.json"
	configFile      = ".zcode/v2/config.json"
)

// Materializer 把 ZCode 凭据写成 CLI 读取的 credentials.json/config.json。
type Materializer struct{}

// ProviderID 返回 ZCode 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 只写缺失的凭据：客户端持有 refresh_token 时会原地续期同一份文件，
// 磁盘那份（非空）必须保留，退出后由 Capture 追平账号库。
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
	credentials, config, err := splitPayload(native.Payload())
	if err != nil || len(credentials) == 0 {
		return nil, ErrUnsupportedCredential
	}
	writes := make([]accountprojection.ArtifactWrite, 0, 2)
	if existing, found := readJSONDocument(filepath.Join(root, credentialsFile)); !found || isEmptyObject(existing) {
		writes = append(writes, accountprojection.ArtifactWrite{
			Path: filepath.Join(root, credentialsFile),
			Data: credentials,
			Mode: 0o600,
		})
	}
	if len(config) > 0 {
		if _, found := readJSONDocument(filepath.Join(root, configFile)); !found {
			writes = append(writes, accountprojection.ArtifactWrite{
				Path: filepath.Join(root, configFile),
				Data: config,
				Mode: 0o600,
			})
		}
	}
	return writes, nil
}

// Capture 读取 CLI 落盘的凭据（可能被加密）并重建账号凭据。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	raw, found := readJSONDocument(filepath.Join(root, credentialsFile))
	if !found {
		return nil, false, nil
	}
	secret := ResolveHostSecret()
	credentials, err := decryptDocument(raw, secret)
	if err != nil || isEmptyObject(credentials) {
		return nil, false, nil
	}
	payload := map[string]json.RawMessage{"credentials": credentials}
	if config, found := readJSONDocument(filepath.Join(root, configFile)); found {
		payload["config"] = config
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": encoded})
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

// splitPayload 从 native_auth_json 里取出 credentials/config。
func splitPayload(payload []byte) (json.RawMessage, json.RawMessage, error) {
	if len(payload) == 0 {
		return nil, nil, ErrUnsupportedCredential
	}
	var document struct {
		Credentials json.RawMessage `json:"credentials"`
		Config      json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, nil, err
	}
	return document.Credentials, document.Config, nil
}

// decryptDocument 逐字段解密 enc:v1 值；非对象或非法 JSON 报错。
func decryptDocument(raw json.RawMessage, secret string) (json.RawMessage, error) {
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		return nil, ErrUnsupportedCredential
	}
	for key, value := range document {
		text, ok := value.(string)
		if !ok || !zcodecred.IsEncrypted(text) {
			continue
		}
		if plain, decrypted := zcodecred.DecryptValue(text, secret); decrypted {
			document[key] = plain
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// readJSONDocument 读取 JSON；缺失或损坏按不存在处理。
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

func isEmptyObject(document json.RawMessage) bool {
	var object map[string]any
	if err := json.Unmarshal(document, &object); err != nil {
		return true
	}
	return len(object) == 0
}

// ResolveHostSecret 按宿主环境派生 ZCode 凭据密钥（CLI 与 Capture 共用）。
func ResolveHostSecret() string {
	home, _ := os.UserHomeDir()
	if injected := os.Getenv("AIH_HOST_HOME"); injected != "" {
		home = injected
	}
	username := os.Getenv("USER")
	if username == "" {
		username = os.Getenv("USERNAME")
	}
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return zcodecred.ResolveSecret(os.Getenv(zcodecred.SecretEnv), platform, home, username)
}
