package kimistorage

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
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 Kimi 支持的形态（原生 OAuth 或 API Key）。
	ErrUnsupportedCredential = errors.New("kimi projection requires oauth or api key credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("kimi projection identity mismatch")
)

const (
	credentialsFile = ".kimi-code/credentials/kimi-code.json"
	deviceFile      = ".kimi-code/device_id"
	configFile      = ".kimi-code/config.toml"
)

// defaultConfig 与 Node kimi-config 的 DEFAULT_KIMI_CONFIG 逐字一致。
const defaultConfig = `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
`

// Materializer 把 Kimi 凭据写成 CLI 读取的 credentials/device_id，并补默认 config.toml。
type Materializer struct{}

// ProviderID 返回 Kimi 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 写凭据（OAuth）或只补默认配置（API Key）；磁盘已有可用凭据时保留。
func (Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	writes := make([]accountprojection.ArtifactWrite, 0, 3)
	if _, statErr := os.Stat(filepath.Join(root, configFile)); errors.Is(statErr, fs.ErrNotExist) {
		writes = append(writes, accountprojection.ArtifactWrite{
			Path: filepath.Join(root, configFile),
			Data: []byte(defaultConfig),
			Mode: 0o600,
		})
	}
	switch credential := request.Credential.(type) {
	case *accountcore.NativeCredential:
		if credential == nil || credential.ProviderID() != ProviderID {
			return nil, ErrUnsupportedCredential
		}
		credentials, deviceID, err := splitPayload(credential.Payload())
		if err != nil || len(credentials) == 0 {
			return nil, ErrUnsupportedCredential
		}
		if existing, found := readJSONDocument(filepath.Join(root, credentialsFile)); found && hasUsableCredential(existing) {
			return writes, nil
		}
		writes = append(writes, accountprojection.ArtifactWrite{
			Path: filepath.Join(root, credentialsFile),
			Data: credentials,
			Mode: 0o600,
		})
		if len(deviceID) > 0 {
			writes = append(writes, accountprojection.ArtifactWrite{
				Path: filepath.Join(root, deviceFile),
				Data: deviceID,
				Mode: 0o600,
			})
		}
		return writes, nil
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != ProviderID {
			return nil, ErrUnsupportedCredential
		}
		return writes, nil
	default:
		return nil, ErrUnsupportedCredential
	}
}

// Capture 读取 credentials/device_id 并重建凭据；身份不一致时报错。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	credentials, found := readJSONDocument(filepath.Join(root, credentialsFile))
	if !found || !hasUsableCredential(credentials) {
		return nil, false, nil
	}
	document := map[string]json.RawMessage{"credentials": credentials}
	if raw, err := os.ReadFile(filepath.Join(root, deviceFile)); err == nil && len(raw) > 0 && len(raw) <= 4096 {
		deviceID, marshalErr := json.Marshal(strings.TrimSpace(string(raw)))
		if marshalErr == nil {
			document["deviceId"] = deviceID
		}
	}
	payload, err := json.Marshal(document)
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

// splitPayload 从 native_auth_json 里取出 credentials 与 deviceId。
func splitPayload(payload []byte) (json.RawMessage, json.RawMessage, error) {
	if len(payload) == 0 {
		return nil, nil, ErrUnsupportedCredential
	}
	var document struct {
		Credentials json.RawMessage `json:"credentials"`
		DeviceID    json.RawMessage `json:"deviceId"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, nil, err
	}
	return document.Credentials, document.DeviceID, nil
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

// hasUsableCredential 判断凭据里是否有 access/refresh token。
func hasUsableCredential(document json.RawMessage) bool {
	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil || root == nil {
		return false
	}
	for _, key := range []string{"access_token", "accessToken", "refresh_token", "refreshToken"} {
		if value, ok := root[key].(string); ok && value != "" {
			return true
		}
	}
	return false
}
