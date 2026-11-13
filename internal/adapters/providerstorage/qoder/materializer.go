package qoderstorage

import (
	"bytes"
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
	// ErrUnsupportedCredential 表示凭据不是 Qoder 原生 OAuth。
	ErrUnsupportedCredential = errors.New("qoder projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("qoder projection identity mismatch")
)

const (
	credentialsFile = ".auth/user"
	machineIDFile   = ".auth/machine_id"
	dnsCacheFile    = ".cache/dns-cache.json"
)

// Materializer 把 Qoder 凭据写成 CLI 读取的 .auth/user 与 machine_id。
type Materializer struct {
	providerID string
}

// NewMaterializer 创建指定 Provider 的 materializer。
func NewMaterializer(providerID string) (*Materializer, bool) {
	if _, ok := Policy(providerID); !ok {
		return nil, false
	}
	return &Materializer{providerID: providerID}, true
}

// ProviderID 返回 Provider 规范 ID。
func (materializer *Materializer) ProviderID() string {
	if materializer == nil {
		return ""
	}
	return materializer.providerID
}

// Materialize 只写缺失的 .auth/user：Qoder 会原地续期同一份凭据文件。
func (materializer *Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if materializer == nil || request.ProviderID != materializer.providerID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	native, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != materializer.providerID {
		return nil, ErrUnsupportedCredential
	}
	fields, err := splitPayload(native.Payload())
	if err != nil || len(fields.credentials) == 0 {
		return nil, ErrUnsupportedCredential
	}
	writes := make([]accountprojection.ArtifactWrite, 0, 3)
	if raw, readErr := os.ReadFile(filepath.Join(root, credentialsFile)); readErr != nil || len(bytes.TrimSpace(raw)) == 0 {
		writes = append(writes, accountprojection.ArtifactWrite{
			Path: filepath.Join(root, credentialsFile),
			Data: fields.credentials,
			Mode: 0o600,
		})
	}
	if len(fields.machineID) > 0 {
		if _, readErr := os.ReadFile(filepath.Join(root, machineIDFile)); readErr != nil {
			writes = append(writes, accountprojection.ArtifactWrite{
				Path: filepath.Join(root, machineIDFile),
				Data: fields.machineID,
				Mode: 0o600,
			})
		}
	}
	if len(fields.dnsCache) > 0 {
		if _, readErr := os.ReadFile(filepath.Join(root, dnsCacheFile)); readErr != nil {
			writes = append(writes, accountprojection.ArtifactWrite{
				Path: filepath.Join(root, dnsCacheFile),
				Data: fields.dnsCache,
				Mode: 0o600,
			})
		}
	}
	return writes, nil
}

// Capture 读取 CLI 落盘的凭据，合并回当前原生凭据并重建账号凭据。
func (materializer *Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if materializer == nil || request.ProviderID != materializer.providerID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	current, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || current == nil {
		return nil, false, ErrUnsupportedCredential
	}
	credentials, readErr := os.ReadFile(filepath.Join(root, credentialsFile))
	if errors.Is(readErr, fs.ErrNotExist) || readErr != nil || len(bytes.TrimSpace(credentials)) == 0 {
		return nil, false, nil
	}
	document := map[string]any{}
	if err := json.Unmarshal(current.Payload(), &document); err != nil {
		return nil, false, err
	}
	document["credentials"] = string(credentials)
	if raw, err := os.ReadFile(filepath.Join(root, machineIDFile)); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		document["machineId"] = strings.TrimSpace(string(raw))
	}
	if raw, err := os.ReadFile(filepath.Join(root, dnsCacheFile)); err == nil && json.Valid(raw) {
		var cache any
		if json.Unmarshal(raw, &cache) == nil {
			document["dnsCache"] = cache
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
	next, _, err := nativeaccount.NewDecoder().Decode(materializer.providerID, envelope)
	if err != nil {
		return nil, false, err
	}
	nextNative, ok := next.(*accountcore.NativeCredential)
	if !ok || nextNative == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current.IdentitySeed() != nextNative.IdentitySeed() {
		return nil, false, ErrIdentityMismatch
	}
	return nextNative, true, nil
}

// ShouldAdopt 在身份不变且内容有变化时回写：Qoder 的凭据是 opaque blob，
// 没有可比较的代际，磁盘内容就是客户端最近一次续期的结果。
func (materializer *Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	if currentNative.IdentitySeed() != nextNative.IdentitySeed() {
		return false
	}
	// 只有 CLI 会改写的 credentials 变化才回写；userInfo 等字段的键序差异
	// 不应该制造一次无意义的账号库更新。
	currentFields, currentErr := splitPayload(currentNative.Payload())
	nextFields, nextErr := splitPayload(nextNative.Payload())
	if currentErr != nil || nextErr != nil {
		return false
	}
	return !bytes.Equal(currentFields.credentials, nextFields.credentials)
}

type payloadFields struct {
	credentials []byte
	machineID   []byte
	dnsCache    []byte
}

// splitPayload 从 native_auth_json 里取出三个 artifact 字段。
func splitPayload(payload []byte) (payloadFields, error) {
	if len(payload) == 0 {
		return payloadFields{}, ErrUnsupportedCredential
	}
	var document struct {
		Credentials string          `json:"credentials"`
		MachineID   string          `json:"machineId"`
		DNSCache    json.RawMessage `json:"dnsCache"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return payloadFields{}, err
	}
	fields := payloadFields{}
	if document.Credentials != "" {
		fields.credentials = []byte(document.Credentials)
	}
	if document.MachineID != "" {
		fields.machineID = []byte(document.MachineID)
	}
	if len(document.DNSCache) > 0 {
		fields.dnsCache = document.DNSCache
	}
	return fields, nil
}
