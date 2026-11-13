package codebuddyfamilystorage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var (
	// ErrUnsupportedCredential 表示账号不是 CodeBuddy 家族的原生凭据。
	ErrUnsupportedCredential = errors.New("codebuddy family projection requires native credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("codebuddy family projection identity mismatch")
)

// Materializer 把家族原生凭据编码成共享 .info，并读取 CLI 续期后的文件。
type Materializer struct {
	providerID string
	decoder    *nativeaccount.Decoder
}

// NewMaterializer 创建指定家族 Provider 的凭据物化器。
func NewMaterializer(providerID string) (*Materializer, error) {
	id := strings.ToLower(strings.TrimSpace(providerID))
	if !IsFamilyProvider(id) {
		return nil, ErrUnsupportedCredential
	}
	return &Materializer{providerID: id, decoder: nativeaccount.NewDecoder()}, nil
}

// ProviderID 返回物化器唯一支持的 Provider。
func (materializer *Materializer) ProviderID() string {
	if materializer == nil {
		return ""
	}
	return materializer.providerID
}

type nativeDocument struct {
	Credentials json.RawMessage `json:"credentials"`
	HostID      string          `json:"codebuddyCredentialHostId"`
}

// Materialize 只编码，不落盘；Provisioner 负责权限和原子替换。
func (materializer *Materializer) Materialize(
	ctx context.Context,
	request accountprojection.Request,
	policy accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if materializer == nil || root == "" || request.ProviderID != materializer.providerID {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	// API Key 账号没有 .info 可写：身份由启动策略注入的 CODEBUDDY_API_KEY 决定，
	// 伪 HOME 只是隔离宿主登录态。
	if _, ok := request.Credential.(*accountcore.StaticAPIKeyAuth); ok {
		return nil, nil
	}
	native, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != materializer.providerID {
		return nil, ErrUnsupportedCredential
	}
	document, err := parseNativeDocument(native.Payload())
	if err != nil || len(document.Credentials) == 0 {
		return nil, ErrUnsupportedCredential
	}
	path := materializer.authPath(root, document.HostID)
	currentExpiry := documentExpiry(document.Credentials)
	// 客户端会原地续期 .info。磁盘那份比账号快照新时保持磁盘内容，退出后由 Capture 追平；
	// 用旧快照覆盖会让刚轮换的 refresh_token 直接失效。
	if existing, found := readCredentialFile(path); found {
		if documentExpiry(existing) > currentExpiry {
			return nil, nil
		}
	}
	data, err := json.Marshal(json.RawMessage(document.Credentials))
	if err != nil {
		return nil, err
	}
	return []accountprojection.ArtifactWrite{{Path: path, Data: data, Mode: 0o600}}, nil
}

// Capture 读取投影里的 .info；文件缺失视为没有变化。
func (materializer *Materializer) Capture(
	ctx context.Context,
	request accountprojection.Request,
	policy accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if materializer == nil || root == "" || request.ProviderID != materializer.providerID {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	// API Key 账号没有可回写的原生文件。
	if _, ok := request.Credential.(*accountcore.StaticAPIKeyAuth); ok {
		return nil, false, nil
	}
	current, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || current == nil || current.ProviderID() != materializer.providerID {
		return nil, false, ErrUnsupportedCredential
	}
	document, err := parseNativeDocument(current.Payload())
	if err != nil {
		return nil, false, ErrUnsupportedCredential
	}
	raw, found := readCredentialFile(materializer.authPath(root, document.HostID))
	if !found {
		return nil, false, nil
	}
	if !json.Valid(raw) {
		return nil, false, ErrUnsupportedCredential
	}
	next, changed, err := materializer.decodeCredentials(current, raw)
	if err != nil || !changed {
		return next, changed, err
	}
	return next, true, nil
}

// decodeCredentials 把 .info 内容合并回当前 native 文档后再解码，保留 hostId 等投影字段。
func (materializer *Materializer) decodeCredentials(
	current *accountcore.NativeCredential,
	credentials json.RawMessage,
) (accountapp.Credential, bool, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(current.Payload(), &document); err != nil {
		return nil, false, ErrUnsupportedCredential
	}
	document["credentials"] = append(json.RawMessage(nil), credentials...)
	merged, err := json.Marshal(document)
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": merged})
	if err != nil {
		return nil, false, err
	}
	decoded, _, err := materializer.decoder.Decode(materializer.providerID, envelope)
	if err != nil {
		return nil, false, ErrUnsupportedCredential
	}
	next, ok := decoded.(*accountcore.NativeCredential)
	if !ok || next == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if next.IdentitySeed() != current.IdentitySeed() {
		return nil, false, ErrIdentityMismatch
	}
	if string(next.Payload()) == string(current.Payload()) {
		return next, false, nil
	}
	return next, true, nil
}

// ShouldAdopt 只在投影文件的代际更新时回写：JWT exp 更晚才认为是新凭据。
func (materializer *Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	if currentNative.ProviderID() != nextNative.ProviderID() ||
		currentNative.IdentitySeed() != nextNative.IdentitySeed() {
		return false
	}
	currentDoc, currentErr := parseNativeDocument(currentNative.Payload())
	nextDoc, nextErr := parseNativeDocument(nextNative.Payload())
	if currentErr != nil || nextErr != nil {
		return false
	}
	nextExpiry, currentExpiry := documentExpiry(nextDoc.Credentials), documentExpiry(currentDoc.Credentials)
	if nextExpiry != currentExpiry {
		return nextExpiry > currentExpiry
	}
	return documentRefreshTime(nextDoc.Credentials) > documentRefreshTime(currentDoc.Credentials)
}

func (materializer *Materializer) authPath(root string, hostID string) string {
	fileName := DefaultAuthFile(materializer.providerID)
	if !strings.HasPrefix(materializer.providerID, "workbuddy") {
		if safe := safeHostID(hostID); safe != "" {
			fileName = safe + ".info"
		}
	}
	segments := append(AuthDirSegments(runtime.GOOS), fileName)
	return filepath.Join(append([]string{root}, segments...)...)
}

func parseNativeDocument(payload []byte) (nativeDocument, error) {
	var document nativeDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		return nativeDocument{}, err
	}
	return document, nil
}

func readCredentialFile(path string) (json.RawMessage, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false
		}
		return nil, false
	}
	if len(data) == 0 || len(data) > 1024*1024 {
		return nil, false
	}
	return append(json.RawMessage(nil), data...), true
}

// documentExpiry 读取 auth.expiresAt（毫秒），缺失时回退 accessToken 的 JWT exp。
func documentExpiry(credentials json.RawMessage) int64 {
	var document struct {
		Auth struct {
			AccessToken string `json:"accessToken"`
			ExpiresAt   int64  `json:"expiresAt"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(credentials, &document); err != nil {
		return 0
	}
	if document.Auth.ExpiresAt > 0 {
		return document.Auth.ExpiresAt
	}
	token := strings.TrimSpace(document.Auth.AccessToken)
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp <= 0 {
		return 0
	}
	return claims.Exp * 1000
}

// documentRefreshTime 读取 auth.lastRefreshTime；缺失时返回 0。
func documentRefreshTime(credentials json.RawMessage) int64 {
	var document struct {
		Auth struct {
			LastRefreshTime int64 `json:"lastRefreshTime"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(credentials, &document); err != nil {
		return 0
	}
	return document.Auth.LastRefreshTime
}

func safeHostID(value string) string {
	text := strings.TrimSuffix(strings.TrimSpace(value), ".info")
	if text == "" || len(text) > 120 {
		return ""
	}
	for index := 0; index < len(text); index++ {
		character := text[index]
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '.' && character != '_' && character != '-' {
			return ""
		}
	}
	return text
}
